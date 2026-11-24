//! Interactive SSH sessions.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use termindo_core::models::{AuthType, CredentialKind, Host, HostOptions, Snippet};
use termindo_core::snippet;
use termindo_ssh::shell::{open_shell, ShellEvent, ShellOptions};
use termindo_ssh::{AuthMethod, ConnectConfig, SshConnection};
use zeroize::Zeroizing;

use crate::commands::data::decrypt_secret;
use crate::error::{CmdError, CmdResult};
use crate::interaction::DesktopInteraction;
use crate::state::{AppState, ShellSession};

const MAX_JUMP_DEPTH: usize = 5;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickConnect {
    pub hostname: String,
    pub port: Option<u16>,
    pub username: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectTarget {
    pub host_id: Option<String>,
    pub quick: Option<QuickConnect>,
    /// One-off password (or key passphrase) entered in a prompt; never stored.
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub session_id: String,
    pub target: String,
}

/// Resolve a host into a connection config (credentials decrypted, jump hosts expanded).
pub fn build_config(
    state: &AppState,
    host: &Host,
    password: Option<&str>,
    depth: usize,
) -> CmdResult<ConnectConfig> {
    if depth > MAX_JUMP_DEPTH {
        return Err(CmdError::invalid(
            "jump host chain is too long (or contains a loop)",
        ));
    }
    let credential = match &host.credential_id {
        Some(id) => Some(state.db().get::<termindo_core::models::Credential>(id)?),
        None => None,
    };
    let secret = match &credential {
        Some(c) => Some(decrypt_secret(state, c)?),
        None => None,
    };

    let auth = match host.auth_type {
        AuthType::Password => {
            let pw = secret
                .as_ref()
                .and_then(|s| s.password.clone())
                .or_else(|| password.map(str::to_string))
                .ok_or_else(|| {
                    CmdError::new(
                        "password_required",
                        format!("password required for {}", host.display_name()),
                    )
                })?;
            AuthMethod::Password(Zeroizing::new(pw))
        }
        AuthType::Key => {
            let secret = secret
                .filter(|_| {
                    matches!(
                        credential.as_ref().map(|c| c.kind),
                        Some(CredentialKind::PrivateKey)
                    )
                })
                .ok_or_else(|| {
                    CmdError::invalid(format!(
                        "{}: select a private key in the host settings",
                        host.display_name()
                    ))
                })?;
            let pem = secret.private_key.clone().unwrap_or_default();
            let passphrase = secret
                .passphrase
                .clone()
                .or_else(|| password.map(str::to_string));
            if passphrase.is_none() && termindo_ssh::keys::is_encrypted(&pem) {
                return Err(CmdError::new(
                    "passphrase_required",
                    format!("the key for {} needs its passphrase", host.display_name()),
                ));
            }
            AuthMethod::PrivateKey {
                pem: Zeroizing::new(pem),
                passphrase: passphrase.map(Zeroizing::new),
            }
        }
        AuthType::Agent => AuthMethod::Agent,
        AuthType::Interactive => AuthMethod::Interactive,
    };

    let username = if host.username.is_empty() {
        whoami()
    } else {
        host.username.clone()
    };
    let mut cfg = ConnectConfig::new(host.hostname.clone(), host.port, username, auth);
    cfg.keepalive_secs = host.options.keepalive_secs.unwrap_or(30);
    if let Some(jump_id) = &host.jump_host_id {
        let jump: Host = state.db().get(jump_id).map_err(|_| {
            CmdError::invalid(format!(
                "{}: jump host no longer exists",
                host.display_name()
            ))
        })?;
        cfg.jump = Some(Box::new(build_config(state, &jump, None, depth + 1)?));
    }
    Ok(cfg)
}

fn whoami() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".into())
}

fn quick_host(q: &QuickConnect) -> Host {
    Host {
        id: String::new(),
        group_id: None,
        label: q.hostname.clone(),
        hostname: q.hostname.clone(),
        port: q.port.unwrap_or(22),
        username: q.username.clone(),
        auth_type: AuthType::Password,
        credential_id: None,
        jump_host_id: None,
        tags: Vec::new(),
        options: HostOptions::default(),
        notes: String::new(),
        updated_at: 0,
        deleted_at: None,
    }
}

pub fn resolve_target(state: &AppState, target: &ConnectTarget) -> CmdResult<Host> {
    match (&target.host_id, &target.quick) {
        (Some(id), _) => Ok(state.db().get::<Host>(id)?),
        (None, Some(q)) => Ok(quick_host(q)),
        _ => Err(CmdError::invalid("no host given")),
    }
}

/// Connect (with UI prompts for host keys / keyboard-interactive) and record history.
/// Returns the connection and the history row id (for saved hosts).
pub async fn connect_host(
    app: &AppHandle,
    host: &Host,
    password: Option<&str>,
) -> CmdResult<(SshConnection, Option<i64>)> {
    let state = app.state::<AppState>();
    let cfg = build_config(&state, host, password, 0)?;
    let interaction = Arc::new(DesktopInteraction {
        app: app.clone(),
        label: host.display_name().to_string(),
    });
    let result = SshConnection::connect(cfg, interaction).await;
    let mut log_id = None;
    if !host.id.is_empty() {
        let err = result.as_ref().err().map(|e| e.to_string());
        log_id = state
            .db()
            .log_connection_start(&host.id, result.is_ok(), err.as_deref())
            .ok();
    }
    Ok((result?, log_id))
}

fn host_vars(host: &Host) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    vars.insert("host".into(), host.hostname.clone());
    vars.insert("hostname".into(), host.hostname.clone());
    vars.insert("port".into(), host.port.to_string());
    vars.insert("user".into(), host.username.clone());
    vars.insert("label".into(), host.display_name().to_string());
    vars
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    target: ConnectTarget,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> CmdResult<ConnectInfo> {
    let host = resolve_target(&state, &target)?;
    // Reconnecting an existing tab: close the previous connection first.
    if let Some(old) = state.sessions.lock().unwrap().remove(&session_id) {
        old.user_closed.store(true, Ordering::SeqCst);
        old.shell.close();
    }

    let (conn, log_id) = connect_host(&app, &host, target.password.as_deref()).await?;
    let conn = Arc::new(conn);

    // Coalesce output chunks into fewer IPC messages under heavy output.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let user_closed = Arc::new(AtomicBool::new(false));
    {
        tauri::async_runtime::spawn(async move {
            while let Some(mut buf) = rx.recv().await {
                if buf.is_empty() {
                    break; // close marker
                }
                while buf.len() < 512 * 1024 {
                    match rx.try_recv() {
                        Ok(more) if !more.is_empty() => buf.extend_from_slice(&more),
                        Ok(_) => break,
                        Err(_) => break,
                    }
                }
                if on_data.send(InvokeResponseBody::Raw(buf)).is_err() {
                    break;
                }
            }
        });
    }

    let opts = ShellOptions {
        term: host
            .options
            .term_type
            .clone()
            .unwrap_or_else(|| "xterm-256color".into()),
        cols,
        rows,
        env: host.options.env.clone(),
    };
    let close_app = app.clone();
    let close_sid = session_id.clone();
    let close_flag = user_closed.clone();
    let shell = open_shell(&conn, opts, move |ev| match ev {
        ShellEvent::Data(d) => {
            let _ = tx.send(d);
        }
        ShellEvent::Closed { exit_status } => {
            let _ = tx.send(Vec::new());
            let state = close_app.state::<AppState>();
            let removed = {
                let mut sessions = state.sessions.lock().unwrap();
                // Only remove if it's still this connection (not replaced by a reconnect).
                let same = sessions
                    .get(&close_sid)
                    .map(|s| Arc::ptr_eq(&s.user_closed, &close_flag))
                    .unwrap_or(false);
                if same {
                    sessions.remove(&close_sid)
                } else {
                    None
                }
            };
            if let Some(s) = &removed {
                if let Some(id) = s.log_id {
                    let _ = state.db().log_connection_end(id);
                }
            }
            let _ = close_app.emit(
                "ssh-closed",
                json!({
                    "sessionId": close_sid,
                    "exitStatus": exit_status,
                    "userClosed": close_flag.load(Ordering::SeqCst),
                }),
            );
        }
    })
    .await?;

    // Startup snippet.
    if let Some(snippet_id) = &host.options.startup_snippet_id {
        if let Ok(snip) = state.db().get::<Snippet>(snippet_id) {
            let body = snippet::render(&snip.body, &host_vars(&host));
            let shell = shell.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                shell.write(format!("{body}\r").into_bytes());
            });
        }
    }

    let target_str = conn.target().to_string();
    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        ShellSession {
            conn,
            shell,
            host_id: (!host.id.is_empty()).then(|| host.id.clone()),
            log_id,
            user_closed,
        },
    );
    Ok(ConnectInfo {
        session_id,
        target: target_str,
    })
}

#[tauri::command]
pub fn ssh_write(state: State<'_, AppState>, session_id: String, data: String) -> CmdResult<()> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions
        .get(&session_id)
        .ok_or_else(|| CmdError::not_found("session is not connected"))?;
    s.shell.write(data.into_bytes());
    Ok(())
}

#[tauri::command]
pub fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> CmdResult<()> {
    if let Some(s) = state.sessions.lock().unwrap().get(&session_id) {
        s.shell.resize(cols, rows);
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_close(state: State<'_, AppState>, session_id: String) -> CmdResult<()> {
    let session = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(s) = session {
        s.user_closed.store(true, Ordering::SeqCst);
        s.shell.close();
        if let Some(id) = s.log_id {
            let _ = state.db().log_connection_end(id);
        }
        // Only disconnect if no other channel (e.g. SFTP) shares this connection.
        if Arc::strong_count(&s.conn) == 1 {
            s.conn.disconnect().await;
        }
    }
    Ok(())
}

/// Answer a pending UI prompt (host key, keyboard-interactive).
#[tauri::command]
pub fn prompt_respond(state: State<'_, AppState>, id: String, value: Value) -> CmdResult<()> {
    if let Some(tx) = state.prompts.lock().unwrap().remove(&id) {
        let _ = tx.send(value);
    }
    Ok(())
}

/// Render a snippet for each target session and type it into the terminal.
#[tauri::command]
pub fn snippet_run(
    state: State<'_, AppState>,
    body: String,
    session_ids: Vec<String>,
    vars: HashMap<String, String>,
    execute: bool,
) -> CmdResult<usize> {
    let sessions = state.sessions.lock().unwrap();
    let mut sent = 0;
    for sid in &session_ids {
        let Some(s) = sessions.get(sid) else { continue };
        let mut all = vars.clone();
        if let Some(host) = s
            .host_id
            .as_ref()
            .and_then(|id| state.db().get::<Host>(id).ok())
        {
            for (k, v) in host_vars(&host) {
                all.entry(k).or_insert(v);
            }
        }
        let mut text = snippet::render(&body, &all);
        if execute && !text.ends_with('\n') && !text.ends_with('\r') {
            text.push('\r');
        }
        // Terminals expect CR for Enter.
        let text = text.replace("\r\n", "\r").replace('\n', "\r");
        if s.shell.write(text.into_bytes()) {
            sent += 1;
        }
    }
    Ok(sent)
}
