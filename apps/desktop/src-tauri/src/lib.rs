//! Termindo desktop: Tauri commands bridging the React UI to the Rust core.

mod commands;
mod error;
mod interaction;
mod state;
mod sync;
mod transfers;

use std::path::PathBuf;

use tauri::Manager;
use termindo_core::db::Db;

use crate::commands::{account, data, sftp, ssh, update, vault};
use crate::state::AppState;

fn data_dir(app: &tauri::App) -> PathBuf {
    if let Ok(dir) = std::env::var("TERMINDO_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from(".termindo"));
    migrate_legacy_data_dir(&dir);
    dir
}

/// Early builds used the bundle identifier `dev.termindo.app`, which macOS
/// confuses with an application bundle. Move that data directory over once.
fn migrate_legacy_data_dir(dir: &std::path::Path) {
    let Some(legacy) = dir.parent().map(|p| p.join("dev.termindo.app")) else {
        return;
    };
    // The webview may already have created `dir` for its caches, so decide on the database.
    if dir.join("termindo.db").exists() || !legacy.join("termindo.db").exists() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        tracing::warn!("could not create data directory {}: {e}", dir.display());
        return;
    }
    let Ok(entries) = std::fs::read_dir(&legacy) else {
        return;
    };
    for entry in entries.flatten() {
        let target = dir.join(entry.file_name());
        if target.exists() {
            continue;
        }
        if let Err(e) = std::fs::rename(entry.path(), &target) {
            tracing::warn!("could not move {}: {e}", entry.path().display());
        }
    }
    let _ = std::fs::remove_dir_all(&legacy);
    tracing::info!(from = %legacy.display(), to = %dir.display(), "moved data directory");
}

/// Errors from the web UI, written to the app log (stderr).
#[tauri::command]
fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{message}"),
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        _ => tracing::info!(target: "frontend", "{message}"),
    }
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,russh=warn".into()),
        )
        .init();

    let mut builder = tauri::Builder::default();
    // A separate profile (TERMINDO_DATA_DIR) may run next to the main instance.
    if std::env::var_os("TERMINDO_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = data_dir(app);
            std::fs::create_dir_all(&dir)?;
            // Leftovers from remote-edit sessions of a previous run.
            let _ = std::fs::remove_dir_all(dir.join("tmp"));
            let db = Db::open(dir.join("termindo.db"))?;
            tracing::info!(path = %dir.display(), "data directory");
            app.manage(AppState::new(db, dir));
            sync::spawn_loop(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // vault
            vault::vault_status,
            vault::vault_create,
            vault::vault_unlock,
            vault::vault_unlock_keychain,
            vault::vault_set_keychain,
            vault::vault_lock,
            vault::vault_change_password,
            vault::vault_recover,
            // data
            data::groups_list,
            data::group_save,
            data::group_delete,
            data::hosts_list,
            data::host_save,
            data::host_delete,
            data::host_duplicate,
            data::host_stats,
            data::history_list,
            data::credentials_list,
            data::credential_save,
            data::credential_delete,
            data::credential_reveal,
            data::credential_generate_key,
            data::credential_import_key_file,
            data::key_inspect,
            data::snippets_list,
            data::snippet_save,
            data::snippet_delete,
            data::snippet_placeholders,
            data::known_hosts_list,
            data::known_host_delete,
            data::setting_get,
            data::setting_set,
            data::import_ssh_config,
            data::export_ssh_config,
            data::export_backup,
            data::import_backup,
            // ssh
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_close,
            ssh::prompt_respond,
            ssh::snippet_run,
            // sftp
            sftp::sftp_open,
            sftp::sftp_close,
            sftp::sftp_list,
            sftp::sftp_realpath,
            sftp::sftp_mkdir,
            sftp::sftp_create_file,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_chmod,
            sftp::local_home,
            sftp::local_list,
            sftp::local_parent,
            sftp::transfer_upload,
            sftp::transfer_download,
            sftp::transfers_list,
            sftp::transfer_pause,
            sftp::transfer_resume,
            sftp::transfer_cancel,
            sftp::transfer_set_priority,
            sftp::transfers_clear,
            sftp::sftp_edit,
            sftp::sftp_edit_stop,
            sftp::open_local,
            // account & sync
            account::account_info,
            account::account_register,
            account::account_login,
            account::account_recover,
            account::account_logout,
            account::account_devices,
            account::account_revoke_device,
            account::sync_now,
            // updates
            update::update_check,
            update::update_mode,
            frontend_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Termindo");
}
