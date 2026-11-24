//! Error type returned by every Tauri command: `{ code, message }` on the JS side.

use serde::Serialize;
use termindo_core::Error as CoreError;
use termindo_ssh::SshError;
use termindo_sync::client::ClientError;
use termindo_sync::engine::SyncError;

#[derive(Debug, Clone, Serialize)]
pub struct CmdError {
    pub code: String,
    pub message: String,
}

pub type CmdResult<T> = Result<T, CmdError>;

impl CmdError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid", message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }
}

impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<CoreError> for CmdError {
    fn from(e: CoreError) -> Self {
        let code = match &e {
            CoreError::WrongPassword => "wrong_password",
            CoreError::VaultLocked => "vault_locked",
            CoreError::VaultNotInitialized => "vault_not_initialized",
            CoreError::VaultAlreadyInitialized => "vault_exists",
            CoreError::NotFound(_) => "not_found",
            CoreError::Invalid(_) => "invalid",
            _ => "internal",
        };
        Self::new(code, e.to_string())
    }
}

impl From<SshError> for CmdError {
    fn from(e: SshError) -> Self {
        let code = match &e {
            SshError::Auth(_) => "auth_failed",
            SshError::HostKeyRejected(_) => "host_key_rejected",
            SshError::Timeout => "timeout",
            SshError::Connect(_) => "connect_failed",
            SshError::Cancelled => "cancelled",
            _ => "ssh",
        };
        Self::new(code, e.to_string())
    }
}

impl From<ClientError> for CmdError {
    fn from(e: ClientError) -> Self {
        match &e {
            ClientError::Api { code, .. } => Self::new(code, e.to_string()),
            ClientError::NotSignedIn => Self::new("not_signed_in", e.to_string()),
            ClientError::Network(_) => Self::new("network", e.to_string()),
            ClientError::Decode(_) => Self::new("server", e.to_string()),
        }
    }
}

impl From<SyncError> for CmdError {
    fn from(e: SyncError) -> Self {
        match e {
            SyncError::Client(c) => c.into(),
            SyncError::Core(c) => c.into(),
        }
    }
}

impl From<std::io::Error> for CmdError {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e.to_string())
    }
}

impl From<serde_json::Error> for CmdError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("invalid", e.to_string())
    }
}

impl From<tauri::Error> for CmdError {
    fn from(e: tauri::Error) -> Self {
        Self::new("internal", e.to_string())
    }
}
