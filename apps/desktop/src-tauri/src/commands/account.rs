//! Sync account: register, login (adopting the account's keys), logout, devices, recovery.

use std::sync::Arc;

use tauri::{AppHandle, State};
use termindo_core::crypto::{self, KdfParams, SALT_LEN};
use termindo_core::vault::{self, UnlockedKeys, VaultMeta};
use termindo_sync::client::SyncClient;
use termindo_sync::engine::{self, SyncReport};
use termindo_sync::protocol::*;
use zeroize::Zeroizing;

use crate::commands::vault::after_unlock;
use crate::error::{CmdError, CmdResult};
use crate::state::AppState;
use crate::sync::{self, AccountInfo};

fn normalize_url(url: &str) -> CmdResult<String> {
    let url = url.trim().trim_end_matches('/');
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(CmdError::invalid(
            "server URL must start with https:// or http://",
        ));
    }
    Ok(url.to_string())
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> termindo_core::Result<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CmdError::new("internal", e.to_string()))?
        .map_err(CmdError::from)
}

fn meta_from_account(keys: &AccountKeys) -> CmdResult<VaultMeta> {
    Ok(VaultMeta {
        kdf_salt: crypto::unb64(&keys.kdf_salt)?,
        kdf: keys.kdf,
        wrapped_dek: crypto::unb64(&keys.wrapped_dek)?,
        wrapped_dek_recovery: keys
            .wrapped_dek_recovery
            .as_deref()
            .map(crypto::unb64)
            .transpose()?,
    })
}

/// Make the account's key material the local vault's, re-encrypting local data if needed.
fn adopt_account(
    state: &AppState,
    resp: &AuthResponse,
    server_url: &str,
    keys: UnlockedKeys,
) -> CmdResult<()> {
    let meta = meta_from_account(&resp.keys)?;
    let local = state.db().vault_meta()?;
    if local.is_some() {
        let current = state.keys()?;
        if current.dek.as_ref() != keys.dek.as_ref() {
            let n = sync::rekey_credentials(state, &current.dek, &keys.dek)?;
            tracing::info!(
                credentials = n,
                "re-encrypted local credentials with the account key"
            );
        }
        // Upload everything this device has; the server merges with LWW.
        state.db().mark_all_dirty()?;
    }
    {
        let db = state.db();
        db.set_vault_meta(&meta)?;
        engine::reset_state(&db)?;
        db.set_sync_value(sync::KEY_SERVER_URL, Some(server_url))?;
        db.set_sync_value(sync::KEY_EMAIL, Some(&resp.email))?;
        db.set_sync_value(sync::KEY_USER_ID, Some(&resp.user_id))?;
        db.set_sync_value(sync::KEY_DEVICE_ID, Some(&resp.device_id))?;
    }
    state.set_keys(Some(keys));
    let client = SyncClient::new(server_url);
    client.set_tokens(Some(termindo_sync::client::Tokens {
        access_token: resp.access_token.clone(),
        refresh_token: resp.refresh_token.clone(),
    }));
    sync::persist_tokens(state, &client)?;
    let keys = state.keys()?;
    after_unlock(
        state,
        UnlockedKeys {
            dek: keys.dek.clone(),
            auth_key: keys.auth_key.clone(),
        },
    )?;
    // after_unlock rebuilt the client from the stored refresh token only; keep the
    // live one so the fresh access token is used instead of forcing a refresh.
    state.sync.set_client(Some(Arc::new(client)));
    Ok(())
}

#[tauri::command]
pub fn account_info(state: State<'_, AppState>) -> CmdResult<AccountInfo> {
    sync::account_info(&state)
}

#[tauri::command]
pub async fn account_register(
    state: State<'_, AppState>,
    server_url: String,
    email: String,
    password: String,
    recovery_key: Option<String>,
) -> CmdResult<()> {
    let server_url = normalize_url(&server_url)?;
    let current = state.keys()?;
    let meta = state
        .db()
        .vault_meta()?
        .ok_or_else(|| CmdError::new("vault_not_initialized", "create a vault first"))?;
    let password = Zeroizing::new(password);
    let (salt, kdf) = (meta.kdf_salt.clone(), meta.kdf);
    let pk = blocking(move || vault::password_keys(&password, &salt, &kdf)).await?;
    if pk.auth_key.as_ref() != current.auth_key.as_ref() {
        return Err(CmdError::new(
            "wrong_password",
            "use your current master password as the account password",
        ));
    }

    let recovery_auth_hash = match recovery_key.filter(|k| !k.trim().is_empty()) {
        Some(rk) => {
            let rk_bytes = crypto::decode_recovery_key(&rk)?;
            // Make sure the key really belongs to this vault.
            meta.recover(&rk)?;
            Some(crypto::b64(vault::recovery_auth_key(&rk_bytes).as_ref()))
        }
        None => None,
    };

    let client = SyncClient::new(&server_url);
    let resp = client
        .register(&RegisterRequest {
            email: email.trim().to_string(),
            auth_hash: crypto::b64(current.auth_key.as_ref()),
            keys: AccountKeys {
                kdf_salt: crypto::b64(&meta.kdf_salt),
                kdf: meta.kdf,
                wrapped_dek: crypto::b64(&meta.wrapped_dek),
                wrapped_dek_recovery: if recovery_auth_hash.is_some() {
                    meta.wrapped_dek_recovery.as_deref().map(crypto::b64)
                } else {
                    None
                },
            },
            recovery_auth_hash,
            device_name: sync::device_name(),
        })
        .await?;
    adopt_account(
        &state,
        &resp,
        &server_url,
        UnlockedKeys {
            dek: current.dek.clone(),
            auth_key: current.auth_key.clone(),
        },
    )
}

#[tauri::command]
pub async fn account_login(
    state: State<'_, AppState>,
    server_url: String,
    email: String,
    password: String,
) -> CmdResult<()> {
    let server_url = normalize_url(&server_url)?;
    if state.db().vault_meta()?.is_some() && !state.is_unlocked() {
        return Err(CmdError::new(
            "vault_locked",
            "unlock the vault before signing in",
        ));
    }
    let client = SyncClient::new(&server_url);
    let pre = client.prelogin(email.trim()).await?;
    let salt = crypto::unb64(&pre.kdf_salt)?;
    let kdf = pre.kdf;
    let password = Zeroizing::new(password);
    let pk = blocking(move || vault::password_keys(&password, &salt, &kdf)).await?;
    let resp = client
        .login(&LoginRequest {
            email: email.trim().to_string(),
            auth_hash: crypto::b64(pk.auth_key.as_ref()),
            device_name: sync::device_name(),
        })
        .await?;
    let wrapped = crypto::unb64(&resp.keys.wrapped_dek)?;
    let dek = vault::unwrap_dek(&pk.kek, &wrapped)?;
    adopt_account(
        &state,
        &resp,
        &server_url,
        UnlockedKeys {
            dek,
            auth_key: pk.auth_key,
        },
    )
}

/// Reset the account (and local vault) password with the recovery key.
#[tauri::command]
pub async fn account_recover(
    state: State<'_, AppState>,
    server_url: String,
    email: String,
    recovery_key: String,
    new_password: String,
) -> CmdResult<()> {
    let server_url = normalize_url(&server_url)?;
    if state.db().vault_meta()?.is_some() && !state.is_unlocked() {
        return Err(CmdError::new(
            "vault_locked",
            "unlock the vault first, or recover the local vault from the unlock screen",
        ));
    }
    let rk = crypto::decode_recovery_key(&recovery_key)?;
    let recovery_auth_hash = crypto::b64(vault::recovery_auth_key(&rk).as_ref());
    let client = SyncClient::new(&server_url);
    let challenge = client
        .recover_challenge(&RecoverChallengeRequest {
            email: email.trim().to_string(),
            recovery_auth_hash: recovery_auth_hash.clone(),
        })
        .await?;
    let dek = vault::unwrap_dek_recovery(&rk, &crypto::unb64(&challenge.wrapped_dek_recovery)?)?;

    let new_password = Zeroizing::new(new_password);
    if new_password.chars().count() < 8 {
        return Err(CmdError::invalid(
            "master password must be at least 8 characters",
        ));
    }
    let salt = crypto::random_bytes::<SALT_LEN>().to_vec();
    let kdf = KdfParams::default();
    let salt2 = salt.clone();
    let pk = blocking(move || vault::password_keys(&new_password, &salt2, &kdf)).await?;
    let wrapped = vault::wrap_dek(&pk.kek, &dek)?;
    let resp = client
        .recover(&RecoverRequest {
            email: email.trim().to_string(),
            recovery_auth_hash,
            new_auth_hash: crypto::b64(pk.auth_key.as_ref()),
            kdf_salt: crypto::b64(&salt),
            kdf,
            wrapped_dek: crypto::b64(&wrapped),
            device_name: sync::device_name(),
        })
        .await?;
    adopt_account(
        &state,
        &resp,
        &server_url,
        UnlockedKeys {
            dek,
            auth_key: pk.auth_key,
        },
    )
}

#[tauri::command]
pub async fn account_logout(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(client) = state.sync.client() {
        let _ = client.logout().await;
    }
    state.sync.set_client(None);
    let db = state.db();
    db.set_sync_value(sync::KEY_REFRESH_TOKEN, None)?;
    db.set_sync_value(sync::KEY_USER_ID, None)?;
    db.set_sync_value(sync::KEY_DEVICE_ID, None)?;
    engine::reset_state(&db)?;
    Ok(())
}

fn client(state: &AppState) -> CmdResult<Arc<SyncClient>> {
    state
        .sync
        .client()
        .ok_or_else(|| CmdError::new("not_signed_in", "not signed in to a sync server"))
}

#[tauri::command]
pub async fn account_devices(state: State<'_, AppState>) -> CmdResult<Vec<Device>> {
    let c = client(&state)?;
    let devices = c.devices().await;
    sync::persist_tokens(&state, &c)?;
    Ok(devices?)
}

#[tauri::command]
pub async fn account_revoke_device(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let c = client(&state)?;
    let res = c.revoke_device(&id).await;
    sync::persist_tokens(&state, &c)?;
    Ok(res?)
}

#[tauri::command]
pub async fn sync_now(app: AppHandle) -> CmdResult<Option<SyncReport>> {
    sync::run_once(&app, true).await
}
