//! Integration tests against a real OpenSSH server.
//!
//! Skipped unless `TERMINDO_TEST_SSH=host:port:user:password` is set.
//! `scripts/test-sshd.sh` starts a suitable Docker container and prints the value.

use std::sync::Arc;
use std::time::Duration;

use termindo_ssh::client::{BoxFuture, InsecureAcceptAll};
use termindo_ssh::sftp::{SftpClient, TransferControl};
use termindo_ssh::shell::{open_shell, ShellEvent, ShellOptions};
use termindo_ssh::{
    AuthMethod, ConnectConfig, HostKeyInfo, Interaction, KbdRequest, SshConnection, SshError,
};
use zeroize::Zeroizing;

fn target() -> Option<(String, u16, String, String)> {
    let v = std::env::var("TERMINDO_TEST_SSH").ok()?;
    let mut it = v.splitn(4, ':');
    Some((
        it.next()?.into(),
        it.next()?.parse().ok()?,
        it.next()?.into(),
        it.next()?.into(),
    ))
}

async fn connect() -> Option<SshConnection> {
    let (host, port, user, pw) = target()?;
    let cfg = ConnectConfig::new(host, port, user, AuthMethod::Password(Zeroizing::new(pw)));
    Some(
        SshConnection::connect(cfg, Arc::new(InsecureAcceptAll))
            .await
            .expect("connect"),
    )
}

#[tokio::test]
async fn exec_and_shell() {
    let Some(conn) = connect().await else {
        return eprintln!("TERMINDO_TEST_SSH not set, skipping");
    };
    let (status, out) = conn.exec("echo hello-termindo").await.unwrap();
    assert_eq!(status, Some(0));
    assert!(String::from_utf8_lossy(&out).contains("hello-termindo"));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let shell = open_shell(&conn, ShellOptions::default(), move |ev| {
        let _ = tx.send(ev);
    })
    .await
    .unwrap();
    shell.resize(120, 40);
    shell.write(b"stty size; echo marker-$((40+2))\r".to_vec());
    let mut buf = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !buf.contains("marker-42") {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(ShellEvent::Data(d))) => buf.push_str(&String::from_utf8_lossy(&d)),
            other => panic!("shell ended early: {other:?}\n{buf}"),
        }
    }
    assert!(buf.contains("40 120"), "pty size not applied: {buf}");
    shell.write(b"exit 3\r".to_vec());
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(ShellEvent::Closed { exit_status })) => {
                assert_eq!(exit_status, Some(3));
                break;
            }
            Ok(Some(_)) => {}
            other => panic!("no close event: {other:?}"),
        }
    }
}

#[tokio::test]
async fn sftp_roundtrip_with_resume() {
    let Some(conn) = connect().await else {
        return eprintln!("TERMINDO_TEST_SSH not set, skipping");
    };
    let sftp = SftpClient::open(&conn).await.unwrap();
    let home = sftp.home_dir().await.unwrap();
    let dir = format!("{home}/termindo-test-{}", std::process::id());
    sftp.mkdir_all(&format!("{dir}/a/b")).await.unwrap();

    let tmp = tempfile::tempdir().unwrap();
    let local = tmp.path().join("big.bin");
    let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&local, &data).unwrap();

    // Cancelled upload, then resume.
    let remote = format!("{dir}/a/b/big.bin");
    let mut partial = None;
    let control = TransferControl::default();
    let stopped = sftp
        .upload(&local, &remote, &mut partial, &control, |done, _| {
            if done > 0 {
                control.cancel();
            }
        })
        .await;
    assert!(matches!(stopped, Err(SshError::Cancelled)));
    assert!(partial.is_some());
    let sent = sftp.stat(&remote).await.unwrap().size;
    assert!(sent > 0 && sent < data.len() as u64);
    let mut first = None;
    let n = sftp
        .upload(
            &local,
            &remote,
            &mut partial,
            &TransferControl::default(),
            |done, _| {
                first.get_or_insert(done);
            },
        )
        .await
        .unwrap();
    assert_eq!(n, data.len() as u64);
    assert_eq!(first, Some(sent), "upload did not resume");
    assert_eq!(sftp.read_file(&remote, n).await.unwrap(), data);

    // Cancelled download, then resume.
    let back = tmp.path().join("back.bin");
    let mut partial = None;
    let control = TransferControl::default();
    let stopped = sftp
        .download(&remote, &back, &mut partial, &control, |done, _| {
            if done > 0 {
                control.cancel();
            }
        })
        .await;
    assert!(matches!(stopped, Err(SshError::Cancelled)));
    let received = std::fs::metadata(&back).unwrap().len();
    assert!(received > 0 && received < data.len() as u64);
    let mut first = None;
    sftp.download(
        &remote,
        &back,
        &mut partial,
        &TransferControl::default(),
        |done, _| {
            first.get_or_insert(done);
        },
    )
    .await
    .unwrap();
    assert_eq!(first, Some(received), "download did not resume");
    assert_eq!(std::fs::read(&back).unwrap(), data);

    let listing = sftp.list(&format!("{dir}/a/b")).await.unwrap();
    assert_eq!(listing.len(), 1);
    assert_eq!(listing[0].size, data.len() as u64);

    sftp.chmod(&remote, 0o600).await.unwrap();
    assert_eq!(sftp.stat(&remote).await.unwrap().permissions, Some(0o600));
    sftp.rename(&remote, &format!("{dir}/renamed.bin"))
        .await
        .unwrap();
    assert_eq!(sftp.walk(&dir).await.unwrap().len(), 3); // a, a/b, renamed.bin

    sftp.remove(&dir).await.unwrap();
    assert!(!sftp.exists(&dir).await.unwrap());
}

/// A file that was already at the destination, or a partial of an older version of the
/// source, must be overwritten rather than appended to.
#[tokio::test]
async fn sftp_never_appends_to_unrelated_data() {
    let Some(conn) = connect().await else {
        return eprintln!("TERMINDO_TEST_SSH not set, skipping");
    };
    let sftp = SftpClient::open(&conn).await.unwrap();
    let home = sftp.home_dir().await.unwrap();
    let remote = format!("{home}/termindo-stale-{}", std::process::id());
    let tmp = tempfile::tempdir().unwrap();
    let local = tmp.path().join("src.bin");
    let back = tmp.path().join("back.bin");
    let new = vec![b'n'; 600_000];
    std::fs::write(&local, &new).unwrap();

    // Existing destinations, both shorter than and as long as the source.
    for old_len in [1_000, new.len()] {
        let old = vec![b'o'; old_len];
        sftp.write_file(&remote, &old).await.unwrap();
        sftp.upload(
            &local,
            &remote,
            &mut None,
            &TransferControl::default(),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(sftp.read_file(&remote, 1 << 20).await.unwrap(), new);

        std::fs::write(&back, &old).unwrap();
        sftp.download(
            &remote,
            &back,
            &mut None,
            &TransferControl::default(),
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), new);
    }

    // Source replaced between two attempts: upload.
    let mut partial = None;
    let control = TransferControl::default();
    let _ = sftp
        .upload(&local, &remote, &mut partial, &control, |done, _| {
            if done > 0 {
                control.cancel();
            }
        })
        .await;
    let changed = vec![b'c'; 700_000];
    std::fs::write(&local, &changed).unwrap();
    sftp.upload(
        &local,
        &remote,
        &mut partial,
        &TransferControl::default(),
        |_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(sftp.read_file(&remote, 1 << 20).await.unwrap(), changed);

    // Source replaced between two attempts: download.
    let mut partial = None;
    let control = TransferControl::default();
    let _ = sftp
        .download(&remote, &back, &mut partial, &control, |done, _| {
            if done > 0 {
                control.cancel();
            }
        })
        .await;
    let changed = vec![b'd'; 800_000];
    sftp.write_file(&remote, &changed).await.unwrap();
    sftp.download(
        &remote,
        &back,
        &mut partial,
        &TransferControl::default(),
        |_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(&back).unwrap(), changed);

    sftp.remove(&remote).await.unwrap();
}

#[tokio::test]
async fn public_key_auth_with_generated_key() {
    let Some(conn) = connect().await else {
        return eprintln!("TERMINDO_TEST_SSH not set, skipping");
    };
    let (private, public) = termindo_ssh::keys::generate_ed25519("it@termindo").unwrap();
    let (status, _) = conn
        .exec(&format!("mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '{public}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"))
        .await
        .unwrap();
    assert_eq!(status, Some(0));

    let (host, port, user, _) = target().unwrap();
    let cfg = ConnectConfig::new(
        host.clone(),
        port,
        user.clone(),
        AuthMethod::PrivateKey {
            pem: private,
            passphrase: None,
        },
    );
    let key_conn = SshConnection::connect(cfg, Arc::new(InsecureAcceptAll))
        .await
        .expect("key auth");
    let (status, out) = key_conn.exec("whoami").await.unwrap();
    assert_eq!(status, Some(0));
    assert_eq!(String::from_utf8_lossy(&out).trim(), user);

    // A wrong password must fail with an auth error, not hang.
    let bad = ConnectConfig::new(
        host,
        port,
        user,
        AuthMethod::Password(Zeroizing::new("definitely-wrong".into())),
    );
    match SshConnection::connect(bad, Arc::new(InsecureAcceptAll)).await {
        Err(termindo_ssh::SshError::Auth(_)) => {}
        Err(e) => panic!("expected auth error, got {e}"),
        Ok(_) => panic!("wrong password accepted"),
    }
}

/// A user who takes longer than the connect timeout to answer a prompt must not be cut off.
#[tokio::test]
async fn slow_host_key_approval_is_not_a_timeout() {
    struct SlowApproval;
    impl Interaction for SlowApproval {
        fn verify_host_key(&self, _info: HostKeyInfo) -> BoxFuture<'_, bool> {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(3)).await;
                true
            })
        }
        fn keyboard_interactive(&self, _req: KbdRequest) -> BoxFuture<'_, Option<Vec<String>>> {
            Box::pin(async { None })
        }
    }

    let Some((host, port, user, pw)) = target() else {
        return eprintln!("TERMINDO_TEST_SSH not set, skipping");
    };
    let mut cfg = ConnectConfig::new(host, port, user, AuthMethod::Password(Zeroizing::new(pw)));
    cfg.connect_timeout = Duration::from_secs(2);
    let conn = SshConnection::connect(cfg, Arc::new(SlowApproval))
        .await
        .expect("connect after a slow approval");
    assert_eq!(conn.exec("true").await.unwrap().0, Some(0));
}

/// An authentication error must say which host in a jump chain rejected us.
#[tokio::test]
async fn jump_host_auth_failure_names_the_hop() {
    let Some((host, port, user, pw)) = target() else {
        return eprintln!("TERMINDO_TEST_SSH not set, skipping");
    };
    let cfg = |password: &str, jump: Option<ConnectConfig>| {
        let auth = AuthMethod::Password(Zeroizing::new(password.into()));
        let mut c = ConnectConfig::new(host.clone(), port, user.clone(), auth);
        c.jump = jump.map(Box::new);
        c
    };
    // The innermost host (hop 2) is the one with the wrong password.
    let chain = cfg(&pw, Some(cfg(&pw, Some(cfg("definitely-wrong", None)))));
    match SshConnection::connect(chain, Arc::new(InsecureAcceptAll)).await {
        Err(termindo_ssh::SshError::JumpAuth { hop: 2, .. }) => {}
        Err(e) => panic!("expected an auth error at hop 2, got {e}"),
        Ok(_) => panic!("wrong password accepted"),
    }
}
