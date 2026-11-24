//! Application state shared by all commands.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use termindo_core::db::Db;
use termindo_core::vault::UnlockedKeys;
use termindo_ssh::sftp::SftpClient;
use termindo_ssh::{ShellHandle, SshConnection};
use tokio::sync::oneshot;

use crate::error::{CmdError, CmdResult};
use crate::sync::SyncState;
use crate::transfers::TransferManager;

pub struct ShellSession {
    pub conn: Arc<SshConnection>,
    pub shell: ShellHandle,
    pub host_id: Option<String>,
    pub log_id: Option<i64>,
    /// Set when the user closed the tab (so the UI doesn't auto-reconnect).
    pub user_closed: Arc<AtomicBool>,
}

pub struct SftpEntry {
    pub conn: Arc<SshConnection>,
    pub client: Arc<SftpClient>,
    /// Remote files currently opened in a local editor: remote path -> stop flag.
    pub edits: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

pub struct AppState {
    pub db: Arc<Mutex<Db>>,
    keys: RwLock<Option<Arc<UnlockedKeys>>>,
    pub sessions: Mutex<HashMap<String, ShellSession>>,
    pub sftp: Mutex<HashMap<String, Arc<SftpEntry>>>,
    pub prompts: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    pub transfers: Arc<TransferManager>,
    pub sync: Arc<SyncState>,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn new(db: Db, data_dir: PathBuf) -> Self {
        Self {
            db: Arc::new(Mutex::new(db)),
            keys: RwLock::new(None),
            sessions: Mutex::new(HashMap::new()),
            sftp: Mutex::new(HashMap::new()),
            prompts: Mutex::new(HashMap::new()),
            transfers: Arc::new(TransferManager::default()),
            sync: Arc::new(SyncState::default()),
            data_dir,
        }
    }

    pub fn db(&self) -> MutexGuard<'_, Db> {
        self.db.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn keys(&self) -> CmdResult<Arc<UnlockedKeys>> {
        self.keys
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| CmdError::new("vault_locked", "the vault is locked"))
    }

    pub fn is_unlocked(&self) -> bool {
        self.keys.read().unwrap().is_some()
    }

    pub fn set_keys(&self, keys: Option<UnlockedKeys>) {
        *self.keys.write().unwrap() = keys.map(Arc::new);
    }

    pub fn sftp_entry(&self, id: &str) -> CmdResult<Arc<SftpEntry>> {
        self.sftp
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| CmdError::not_found("SFTP session is not open"))
    }

    pub fn temp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }
}
