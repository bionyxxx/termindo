//! Background sync: debounced after local edits, plus a periodic pull.

use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use termindo_core::{crypto, vault};
use termindo_sync::client::{ClientError, SyncClient, Tokens};
use termindo_sync::engine::{self, SyncError, SyncReport};

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

pub const KEY_SERVER_URL: &str = "server_url";
pub const KEY_EMAIL: &str = "email";
pub const KEY_USER_ID: &str = "user_id";
pub const KEY_DEVICE_ID: &str = "device_id";
pub const KEY_REFRESH_TOKEN: &str = "refresh_token";
const REFRESH_TOKEN_AAD: &str = "termindo/refresh-token";

const DEBOUNCE: Duration = Duration::from_secs(2);
const DEFAULT_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub syncing: bool,
    pub last_error: Option<String>,
    pub last_report: Option<SyncReport>,
}

#[derive(Default)]
pub struct SyncState {
    pub client: RwLock<Option<Arc<SyncClient>>>,
    notify: tokio::sync::Notify,
    running: tokio::sync::Mutex<()>,
    pub status: Mutex<SyncStatus>,
}

impl SyncState {
    /// Request a sync soon (debounced). Cheap; call after every local change.
    pub fn schedule(&self) {
        self.notify.notify_one();
    }

    pub fn client(&self) -> Option<Arc<SyncClient>> {
        self.client.read().unwrap().clone()
    }

    pub fn set_client(&self, client: Option<Arc<SyncClient>>) {
        *self.client.write().unwrap() = client;
    }
}

/// Spawn the background loop. Runs for the whole app lifetime.
pub fn spawn_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let sync = app.state::<AppState>().sync.clone();
        loop {
            tokio::select! {
                _ = sync.notify.notified() => tokio::time::sleep(DEBOUNCE).await,
                _ = tokio::time::sleep(DEFAULT_INTERVAL) => {}
            }
            if let Err(e) = run_once(&app, false).await {
                tracing::debug!("background sync: {}", e.message);
            }
        }
    });
}

fn emit_status(app: &AppHandle) {
    let status = app.state::<AppState>().sync.status.lock().unwrap().clone();
    let _ = app.emit("sync-status", status);
}

/// Run a sync now if signed in and unlocked. Returns `None` when sync is not configured.
/// `wait`: queue behind a running sync (manual "Sync now") instead of skipping it.
pub async fn run_once(app: &AppHandle, wait: bool) -> CmdResult<Option<SyncReport>> {
    let state = app.state::<AppState>();
    let Some(client) = state.sync.client() else {
        return Ok(None);
    };
    let Ok(keys) = state.keys() else {
        return Ok(None);
    };
    let _guard = if wait {
        state.sync.running.lock().await
    } else {
        match state.sync.running.try_lock() {
            Ok(g) => g,
            Err(_) => return Err(CmdError::new("busy", "a sync is already running")),
        }
    };

    state.sync.status.lock().unwrap().syncing = true;
    emit_status(app);

    let before = client.tokens();
    let result = engine::sync(&client, &state.db, &keys.dek).await;
    if client.tokens().map(|t| t.refresh_token) != before.map(|t| t.refresh_token) {
        if let Err(e) = persist_tokens(&state, &client) {
            tracing::error!("persisting tokens failed: {}", e.message);
        }
    }

    let out = {
        let mut status = state.sync.status.lock().unwrap();
        status.syncing = false;
        match result {
            Ok(report) => {
                status.last_error = None;
                status.last_report = Some(report.clone());
                Ok(Some(report))
            }
            Err(e) => {
                let err: CmdError = match &e {
                    SyncError::Client(ClientError::NotSignedIn) => CmdError::new(
                        "not_signed_in",
                        "sync session expired or this device was revoked; sign in again",
                    ),
                    _ => e.into(),
                };
                status.last_error = Some(err.message.clone());
                Err(err)
            }
        }
    };
    emit_status(app);
    if let Ok(Some(r)) = &out {
        if r.applied > 0 {
            let _ = app.emit("data-changed", "sync");
        }
    }
    out
}

/// Store the (rotating) refresh token, encrypted with the DEK.
pub fn persist_tokens(state: &AppState, client: &SyncClient) -> CmdResult<()> {
    let keys = state.keys()?;
    let db = state.db();
    match client.tokens() {
        Some(t) => {
            let sealed = crypto::seal(
                &keys.dek,
                t.refresh_token.as_bytes(),
                REFRESH_TOKEN_AAD.as_bytes(),
            )?;
            db.set_sync_value(KEY_REFRESH_TOKEN, Some(&crypto::b64(&sealed)))?;
        }
        None => db.set_sync_value(KEY_REFRESH_TOKEN, None)?,
    }
    Ok(())
}

/// After unlocking: rebuild the sync client from stored account data.
pub fn restore_client(state: &AppState) -> CmdResult<()> {
    let keys = state.keys()?;
    let (url, token) = {
        let db = state.db();
        (
            db.sync_value(KEY_SERVER_URL)?,
            db.sync_value(KEY_REFRESH_TOKEN)?,
        )
    };
    let (Some(url), Some(token)) = (url, token) else {
        state.sync.set_client(None);
        return Ok(());
    };
    let sealed = crypto::unb64(&token)?;
    let refresh = crypto::open(&keys.dek, &sealed, REFRESH_TOKEN_AAD.as_bytes())?;
    let client = SyncClient::new(&url);
    client.set_tokens(Some(Tokens {
        access_token: String::new(),
        refresh_token: String::from_utf8_lossy(&refresh).into_owned(),
    }));
    state.sync.set_client(Some(Arc::new(client)));
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub signed_in: bool,
    pub server_url: Option<String>,
    pub email: Option<String>,
    pub device_id: Option<String>,
    pub last_synced_at: Option<i64>,
    pub status: SyncStatus,
}

pub fn account_info(state: &AppState) -> CmdResult<AccountInfo> {
    let db = state.db();
    Ok(AccountInfo {
        signed_in: db.sync_value(KEY_REFRESH_TOKEN)?.is_some(),
        server_url: db.sync_value(KEY_SERVER_URL)?,
        email: db.sync_value(KEY_EMAIL)?,
        device_id: db.sync_value(KEY_DEVICE_ID)?,
        last_synced_at: db
            .sync_value(engine::LAST_SYNC_KEY)?
            .and_then(|v| v.parse().ok()),
        status: state.sync.status.lock().unwrap().clone(),
    })
}

/// Default device name shown in the device list.
pub fn device_name() -> String {
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "desktop".into());
    format!("{host} ({})", std::env::consts::OS)
}

/// Re-encrypt every credential from `old_dek` to `new_dek` (used when adopting an
/// account's DEK on a device that already had its own vault).
pub fn rekey_credentials(
    state: &AppState,
    old_dek: &[u8; 32],
    new_dek: &[u8; 32],
) -> CmdResult<usize> {
    use termindo_core::models::Credential;
    let db = state.db();
    let tx = db
        .conn()
        .unchecked_transaction()
        .map_err(termindo_core::Error::from)?;
    let mut n = 0;
    // Include tombstones: they still carry ciphertext that must stay decryptable.
    let mut stmt = db
        .conn()
        .prepare("SELECT id FROM credentials")
        .map_err(termindo_core::Error::from)?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(termindo_core::Error::from)?
        .collect::<Result<_, _>>()
        .map_err(termindo_core::Error::from)?;
    drop(stmt);
    for id in ids {
        if let Some(mut c) = db.get_any::<Credential>(&id)? {
            let plain = vault::decrypt_field(old_dek, &c.id, &c.data_enc)?;
            c.data_enc = vault::encrypt_field(new_dek, &c.id, &plain)?;
            db.save(&mut c)?;
            n += 1;
        }
    }
    tx.commit().map_err(termindo_core::Error::from)?;
    Ok(n)
}
