//! End-to-end API tests against a real Postgres.
//!
//! Skipped unless `TERMINDO_TEST_DATABASE_URL` is set, e.g.:
//!
//! ```sh
//! docker run --rm -d --name termindo-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17
//! TERMINDO_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres cargo test -p termindo-server
//! ```

use termindo_core::crypto::{self, KdfParams};
use termindo_core::models::Snippet;
use termindo_core::vault::{self, VaultMeta};
use termindo_server::{connect_db, serve, AppState, Config};
use termindo_sync::client::{SyncClient, Tokens};
use termindo_sync::envelope::{decode_entity, open_payload, seal_entity};
use termindo_sync::protocol::*;

const PASSWORD: &str = "correct horse battery";

async fn start() -> Option<String> {
    let url = std::env::var("TERMINDO_TEST_DATABASE_URL").ok()?;
    let db = connect_db(&url).await.expect("connect test database");
    let config = Config {
        database_url: url,
        jwt_secret: crypto::b64(&crypto::random_bytes::<32>()).into_bytes(),
        bind: "127.0.0.1:0".into(),
        allow_registration: true,
        trust_proxy: false,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(serve(
        listener,
        AppState::new(db, config),
        std::future::pending(),
    ));
    Some(format!("http://{addr}"))
}

fn unique_email(tag: &str) -> String {
    format!("{tag}-{}@example.test", termindo_core::new_id())
}

struct Account {
    email: String,
    meta: VaultMeta,
    auth_hash: String,
    dek: crypto::SecretKey,
    recovery_key: String,
}

fn new_account(tag: &str) -> Account {
    let nv = VaultMeta::create(PASSWORD, KdfParams::insecure_for_tests()).unwrap();
    Account {
        email: unique_email(tag),
        auth_hash: crypto::b64(&nv.keys.auth_key[..]),
        dek: nv.keys.dek,
        meta: nv.meta,
        recovery_key: nv.recovery_key,
    }
}

fn account_keys(meta: &VaultMeta) -> AccountKeys {
    AccountKeys {
        kdf_salt: crypto::b64(&meta.kdf_salt),
        kdf: meta.kdf,
        wrapped_dek: crypto::b64(&meta.wrapped_dek),
        wrapped_dek_recovery: meta.wrapped_dek_recovery.as_ref().map(|w| crypto::b64(w)),
    }
}

fn recovery_auth(recovery_key: &str) -> String {
    let rk = crypto::decode_recovery_key(recovery_key).unwrap();
    crypto::b64(&vault::recovery_auth_key(&rk)[..])
}

async fn register(base: &str, acct: &Account, device: &str) -> (SyncClient, AuthResponse) {
    let client = SyncClient::new(base);
    let resp = client
        .register(&RegisterRequest {
            email: acct.email.clone(),
            auth_hash: acct.auth_hash.clone(),
            keys: account_keys(&acct.meta),
            recovery_auth_hash: Some(recovery_auth(&acct.recovery_key)),
            device_name: device.into(),
        })
        .await
        .expect("register");
    (client, resp)
}

fn snippet(id: &str, body: &str, updated_at: i64) -> Snippet {
    Snippet {
        id: id.into(),
        name: id.into(),
        body: body.into(),
        hotkey: None,
        tags: vec![],
        updated_at,
        deleted_at: None,
    }
}

fn push_record(dek: &crypto::SecretKey, s: &Snippet) -> PushRecord {
    PushRecord {
        id: s.id.clone(),
        updated_at: s.updated_at,
        deleted: s.deleted_at.is_some(),
        blob: seal_entity(dek, s).unwrap(),
    }
}

#[tokio::test]
async fn register_login_push_pull_conflict_revoke() {
    let Some(base) = start().await else {
        eprintln!("TERMINDO_TEST_DATABASE_URL not set; skipping");
        return;
    };
    let acct = new_account("flow");

    // prelogin: unknown email gets a deterministic fake salt
    let anon = SyncClient::new(&base);
    let fake1 = anon.prelogin(&acct.email).await.unwrap();
    let fake2 = anon.prelogin(&acct.email.to_uppercase()).await.unwrap();
    assert_eq!(fake1.kdf_salt, fake2.kdf_salt);
    assert_eq!(fake1.kdf, KdfParams::default());

    // register device A
    let (a, ra) = register(&base, &acct, "laptop").await;
    assert_eq!(ra.email, acct.email);
    let pre = anon.prelogin(&acct.email).await.unwrap();
    assert_eq!(pre.kdf_salt, crypto::b64(&acct.meta.kdf_salt));
    assert_eq!(pre.kdf, acct.meta.kdf);

    // duplicate registration
    let dup = SyncClient::new(&base)
        .register(&RegisterRequest {
            email: format!("  {}  ", acct.email.to_uppercase()),
            auth_hash: acct.auth_hash.clone(),
            keys: account_keys(&acct.meta),
            recovery_auth_hash: None,
            device_name: "x".into(),
        })
        .await
        .unwrap_err();
    assert!(
        matches!(
            dup,
            termindo_sync::client::ClientError::Api { status: 409, .. }
        ),
        "{dup:?}"
    );

    // wrong password, then login device B and unwrap the DEK from server-held keys
    let b = SyncClient::new(&base);
    let bad = b
        .login(&LoginRequest {
            email: acct.email.clone(),
            auth_hash: crypto::b64(&[9u8; 32]),
            device_name: "phone".into(),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        bad,
        termindo_sync::client::ClientError::Api { status: 401, .. }
    ));
    let rb = b
        .login(&LoginRequest {
            email: acct.email.clone(),
            auth_hash: acct.auth_hash.clone(),
            device_name: "desktop".into(),
        })
        .await
        .unwrap();
    let salt = crypto::unb64(&rb.keys.kdf_salt).unwrap();
    let pk = vault::password_keys(PASSWORD, &salt, &rb.keys.kdf).unwrap();
    let dek_b = vault::unwrap_dek(&pk.kek, &crypto::unb64(&rb.keys.wrapped_dek).unwrap()).unwrap();
    assert_eq!(*dek_b, *acct.dek);

    // A pushes two records, B pulls them
    let s1 = snippet("s1", "uptime", 1_000);
    let s2 = snippet("s2", "df -h", 1_000);
    let resp = a
        .push(vec![
            push_record(&acct.dek, &s1),
            push_record(&acct.dek, &s2),
        ])
        .await
        .unwrap();
    assert_eq!(resp.accepted.len(), 2);
    assert!(resp.rejected.is_empty());

    let page = b.pull(0, 1).await.unwrap();
    assert_eq!(page.records.len(), 1);
    assert!(page.has_more);
    let page2 = b.pull(page.cursor, 100).await.unwrap();
    assert_eq!(page2.records.len(), 1);
    assert!(!page2.has_more);
    let cursor_b = page2.cursor;
    let got: Snippet = decode_entity(
        "s1",
        open_payload(&dek_b, "s1", &page.records[0].blob).unwrap(),
    )
    .unwrap();
    assert_eq!(got, s1);

    // conflicts: older is rejected, same version is acknowledged, newer wins
    let older = snippet("s1", "older", 500);
    let r = b.push(vec![push_record(&dek_b, &older)]).await.unwrap();
    assert_eq!(r.rejected, vec!["s1".to_string()]);
    let r = b.push(vec![push_record(&dek_b, &s1)]).await.unwrap();
    assert_eq!(r.accepted, vec!["s1".to_string()]);
    assert!(
        b.pull(cursor_b, 100).await.unwrap().records.is_empty(),
        "same-version push must not bump seq"
    );
    let mut newer = snippet("s1", "uptime -p", 2_000);
    newer.deleted_at = Some(2_000);
    let r = b.push(vec![push_record(&dek_b, &newer)]).await.unwrap();
    assert_eq!(r.accepted, vec!["s1".to_string()]);
    let page = a.pull(0, 100).await.unwrap();
    let rec = page.records.iter().find(|r| r.id == "s1").unwrap();
    assert!(rec.deleted);
    assert_eq!(rec.updated_at, 2_000);
    assert_eq!(
        page.records.last().unwrap().id,
        "s1",
        "updated record moves to the end of the change log"
    );

    // oversized push is refused
    let too_many: Vec<PushRecord> = (0..MAX_PUSH + 1)
        .map(|i| push_record(&acct.dek, &snippet(&format!("x{i}"), "", 1)))
        .collect();
    assert!(a.push(too_many).await.is_err());

    // devices: A sees both, revokes B; B is locked out immediately
    let devices = a.devices().await.unwrap();
    assert_eq!(devices.len(), 2);
    assert_eq!(devices.iter().filter(|d| d.current).count(), 1);
    let b_dev = devices.iter().find(|d| !d.current).unwrap();
    assert_eq!(b_dev.id, rb.device_id);
    a.revoke_device(&b_dev.id).await.unwrap();
    let err = b.pull(0, 10).await.unwrap_err();
    assert!(err.is_unauthorized(), "{err:?}");
    assert_eq!(a.devices().await.unwrap().len(), 1);

    // refresh rotation and reuse detection
    let old = a.tokens().unwrap();
    a.refresh().await.unwrap();
    let new = a.tokens().unwrap();
    assert_ne!(old.refresh_token, new.refresh_token);
    a.account_keys().await.unwrap();
    let thief = SyncClient::new(&base);
    thief.set_tokens(Some(Tokens {
        access_token: "x".into(),
        refresh_token: old.refresh_token,
    }));
    assert!(thief.refresh().await.is_err());
    // reuse revoked the device: the legitimate token no longer works either
    assert!(a.refresh().await.is_err());
}

#[tokio::test]
async fn change_password_and_recover() {
    let Some(base) = start().await else {
        eprintln!("TERMINDO_TEST_DATABASE_URL not set; skipping");
        return;
    };
    let acct = new_account("recover");
    let (a, _) = register(&base, &acct, "laptop").await;
    let (b, _) = {
        let b = SyncClient::new(&base);
        let r = b
            .login(&LoginRequest {
                email: acct.email.clone(),
                auth_hash: acct.auth_hash.clone(),
                device_name: "b".into(),
            })
            .await
            .unwrap();
        (b, r)
    };

    // change password on A: B is signed out, A keeps working
    let (meta2, auth2) = acct
        .meta
        .rewrap(
            &acct.dek,
            "a brand new password",
            KdfParams::insecure_for_tests(),
        )
        .unwrap();
    a.change_password(&ChangePasswordRequest {
        current_auth_hash: acct.auth_hash.clone(),
        new_auth_hash: crypto::b64(&auth2[..]),
        kdf_salt: crypto::b64(&meta2.kdf_salt),
        kdf: meta2.kdf,
        wrapped_dek: crypto::b64(&meta2.wrapped_dek),
    })
    .await
    .unwrap();
    assert!(b.devices().await.unwrap_err().is_unauthorized());
    assert_eq!(
        a.account_keys().await.unwrap().wrapped_dek,
        crypto::b64(&meta2.wrapped_dek)
    );
    let old_login = SyncClient::new(&base)
        .login(&LoginRequest {
            email: acct.email.clone(),
            auth_hash: acct.auth_hash.clone(),
            device_name: "c".into(),
        })
        .await;
    assert!(old_login.is_err());

    // recover with the recovery key
    let anon = SyncClient::new(&base);
    let rauth = recovery_auth(&acct.recovery_key);
    assert!(anon
        .recover_challenge(&RecoverChallengeRequest {
            email: acct.email.clone(),
            recovery_auth_hash: crypto::b64(&[1u8; 32])
        })
        .await
        .is_err());
    let ch = anon
        .recover_challenge(&RecoverChallengeRequest {
            email: acct.email.clone(),
            recovery_auth_hash: rauth.clone(),
        })
        .await
        .unwrap();
    let rk = crypto::decode_recovery_key(&acct.recovery_key).unwrap();
    let dek =
        vault::unwrap_dek_recovery(&rk, &crypto::unb64(&ch.wrapped_dek_recovery).unwrap()).unwrap();
    assert_eq!(*dek, *acct.dek);
    let (meta3, auth3) = meta2
        .rewrap(&dek, "recovered password!", KdfParams::insecure_for_tests())
        .unwrap();
    let r = anon
        .recover(&RecoverRequest {
            email: acct.email.clone(),
            recovery_auth_hash: rauth,
            new_auth_hash: crypto::b64(&auth3[..]),
            kdf_salt: crypto::b64(&meta3.kdf_salt),
            kdf: meta3.kdf,
            wrapped_dek: crypto::b64(&meta3.wrapped_dek),
            device_name: "recovered".into(),
        })
        .await
        .unwrap();
    assert_eq!(r.keys.wrapped_dek, crypto::b64(&meta3.wrapped_dek));
    // every pre-recovery device is signed out
    assert!(a.devices().await.unwrap_err().is_unauthorized());
    assert_eq!(anon.devices().await.unwrap().len(), 1);
}
