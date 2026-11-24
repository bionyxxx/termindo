use serde::Serialize;
use tauri::{AppHandle, State};
use termindo_core::crypto::{self, KdfParams};
use termindo_core::vault::{UnlockedKeys, VaultMeta};
use zeroize::Zeroizing;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;
use crate::sync;

// Kept from the original bundle identifier so existing keychain entries keep working.
const KEYCHAIN_SERVICE: &str = "dev.termindo.app";
const KEYCHAIN_USER: &str = "vault-keys";
const CHECK_KEY: &str = "vault_check";
const CHECK_AAD: &[u8] = b"termindo/check/v1";
const KEYCHAIN_SETTING: &str = "unlock_with_keychain";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub unlocked: bool,
    pub keychain_enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedVault {
    pub recovery_key: String,
}

fn kdf_params() -> KdfParams {
    if cfg!(debug_assertions) && std::env::var("TERMINDO_FAST_KDF").is_ok() {
        KdfParams::insecure_for_tests()
    } else {
        KdfParams::default()
    }
}

/// Store a value proving a DEK is the right one (used by keychain unlock).
fn write_check(state: &AppState, dek: &[u8; 32]) -> CmdResult<()> {
    let sealed = crypto::seal(dek, b"ok", CHECK_AAD)?;
    state.db().set_setting(CHECK_KEY, &crypto::b64(&sealed))?;
    Ok(())
}

/// Called after any successful unlock.
pub fn after_unlock(state: &AppState, keys: UnlockedKeys) -> CmdResult<()> {
    let dek = keys.dek.clone();
    state.set_keys(Some(keys));
    write_check(state, &dek)?;
    if keychain_enabled(state) {
        let _ = store_in_keychain(state);
    }
    sync::restore_client(state)?;
    state.sync.schedule();
    Ok(())
}

fn keychain_enabled(state: &AppState) -> bool {
    state
        .db()
        .setting(KEYCHAIN_SETTING)
        .ok()
        .flatten()
        .as_deref()
        == Some("true")
}

fn keychain_entry() -> CmdResult<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .map_err(|e| CmdError::new("keychain", format!("OS keychain unavailable: {e}")))
}

fn store_in_keychain(state: &AppState) -> CmdResult<()> {
    let keys = state.keys()?;
    let mut blob = Zeroizing::new(Vec::with_capacity(64));
    blob.extend_from_slice(keys.dek.as_ref());
    blob.extend_from_slice(keys.auth_key.as_ref());
    keychain_entry()?
        .set_password(&crypto::b64(&blob))
        .map_err(|e| CmdError::new("keychain", format!("could not save to OS keychain: {e}")))
}

#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> CmdResult<VaultStatus> {
    // Each lock is taken in its own statement: a `state.db()` temporary lives until the
    // end of the statement, and locking again inside it would deadlock.
    let initialized = state.db().vault_meta()?.is_some();
    let keychain_enabled = keychain_enabled(&state);
    Ok(VaultStatus {
        initialized,
        unlocked: state.is_unlocked(),
        keychain_enabled,
    })
}

#[tauri::command]
pub async fn vault_create(state: State<'_, AppState>, password: String) -> CmdResult<CreatedVault> {
    if state.db().vault_meta()?.is_some() {
        return Err(CmdError::new("vault_exists", "a vault already exists"));
    }
    let password = Zeroizing::new(password);
    let nv =
        tauri::async_runtime::spawn_blocking(move || VaultMeta::create(&password, kdf_params()))
            .await
            .map_err(|e| CmdError::new("internal", e.to_string()))??;
    state.db().set_vault_meta(&nv.meta)?;
    after_unlock(&state, nv.keys)?;
    Ok(CreatedVault {
        recovery_key: nv.recovery_key,
    })
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, AppState>, password: String) -> CmdResult<()> {
    let meta = state
        .db()
        .vault_meta()?
        .ok_or_else(|| CmdError::new("vault_not_initialized", "no vault yet"))?;
    let password = Zeroizing::new(password);
    let keys = tauri::async_runtime::spawn_blocking(move || meta.unlock(&password))
        .await
        .map_err(|e| CmdError::new("internal", e.to_string()))??;
    after_unlock(&state, keys)
}

/// Unlock with keys remembered in the OS keychain. Returns false if not available.
#[tauri::command]
pub fn vault_unlock_keychain(state: State<'_, AppState>) -> CmdResult<bool> {
    if !keychain_enabled(&state) || state.db().vault_meta()?.is_none() {
        return Ok(false);
    }
    let Ok(secret) = keychain_entry()?.get_password() else {
        return Ok(false);
    };
    let raw = Zeroizing::new(crypto::unb64(&secret)?);
    if raw.len() != 64 {
        return Ok(false);
    }
    let mut dek = Zeroizing::new([0u8; 32]);
    let mut auth = Zeroizing::new([0u8; 32]);
    dek.copy_from_slice(&raw[..32]);
    auth.copy_from_slice(&raw[32..]);
    let check = state
        .db()
        .setting(CHECK_KEY)?
        .ok_or_else(|| CmdError::new("keychain", "no vault check value"))?;
    if crypto::open(&dek, &crypto::unb64(&check)?, CHECK_AAD).is_err() {
        // Stale keychain entry (e.g. password changed on another device).
        let _ = keychain_entry()?.delete_credential();
        return Ok(false);
    }
    after_unlock(
        &state,
        UnlockedKeys {
            dek,
            auth_key: auth,
        },
    )?;
    Ok(true)
}

#[tauri::command]
pub fn vault_set_keychain(state: State<'_, AppState>, enabled: bool) -> CmdResult<()> {
    state.keys()?;
    if enabled {
        store_in_keychain(&state)?;
    } else if let Ok(entry) = keychain_entry() {
        let _ = entry.delete_credential();
    }
    state
        .db()
        .set_setting(KEYCHAIN_SETTING, if enabled { "true" } else { "false" })?;
    Ok(())
}

#[tauri::command]
pub fn vault_lock(state: State<'_, AppState>) -> CmdResult<()> {
    state.set_keys(None);
    state.sync.set_client(None);
    Ok(())
}

#[tauri::command]
pub async fn vault_change_password(
    app: AppHandle,
    state: State<'_, AppState>,
    current: String,
    new_password: String,
) -> CmdResult<()> {
    let meta = state
        .db()
        .vault_meta()?
        .ok_or_else(|| CmdError::new("vault_not_initialized", "no vault"))?;
    let current = Zeroizing::new(current);
    let new_password = Zeroizing::new(new_password);
    let meta2 = meta.clone();
    let (old_keys, (new_meta, new_auth)) = tauri::async_runtime::spawn_blocking(move || {
        let old = meta2.unlock(&current)?;
        let rewrapped = meta2.rewrap(&old.dek, &new_password, kdf_params())?;
        Ok::<_, termindo_core::Error>((old, rewrapped))
    })
    .await
    .map_err(|e| CmdError::new("internal", e.to_string()))??;

    // Update the server first so a failure there leaves both sides consistent.
    if let Some(client) = state.sync.client() {
        client
            .change_password(&termindo_sync::protocol::ChangePasswordRequest {
                current_auth_hash: crypto::b64(old_keys.auth_key.as_ref()),
                new_auth_hash: crypto::b64(new_auth.as_ref()),
                kdf_salt: crypto::b64(&new_meta.kdf_salt),
                kdf: new_meta.kdf,
                wrapped_dek: crypto::b64(&new_meta.wrapped_dek),
            })
            .await?;
        sync::persist_tokens(&state, &client)?;
    }
    state.db().set_vault_meta(&new_meta)?;
    after_unlock(
        &state,
        UnlockedKeys {
            dek: old_keys.dek.clone(),
            auth_key: new_auth,
        },
    )?;
    let _ = app;
    Ok(())
}

/// Reset the master password using the recovery key (offline, local vault only).
#[tauri::command]
pub async fn vault_recover(
    state: State<'_, AppState>,
    recovery_key: String,
    new_password: String,
) -> CmdResult<()> {
    let meta = state
        .db()
        .vault_meta()?
        .ok_or_else(|| CmdError::new("vault_not_initialized", "no vault"))?;
    let new_password = Zeroizing::new(new_password);
    let (dek, (new_meta, auth)) = tauri::async_runtime::spawn_blocking(move || {
        let dek = meta.recover(&recovery_key)?;
        let rewrapped = meta.rewrap(&dek, &new_password, kdf_params())?;
        Ok::<_, termindo_core::Error>((dek, rewrapped))
    })
    .await
    .map_err(|e| CmdError::new("internal", e.to_string()))??;
    state.db().set_vault_meta(&new_meta)?;
    after_unlock(
        &state,
        UnlockedKeys {
            dek,
            auth_key: auth,
        },
    )?;
    // The server still has the old password material: the user must sign in again
    // (account recovery with the same recovery key is available from the login screen).
    if state.sync.client().is_some() {
        state.db().set_sync_value(sync::KEY_REFRESH_TOKEN, None)?;
        state.sync.set_client(None);
    }
    Ok(())
}
