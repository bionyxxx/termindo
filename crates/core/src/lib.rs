//! Termindo core: data model, local SQLite database, encrypted vault, and
//! helpers shared by the desktop app, the sync engine and the server.

pub mod backup;
pub mod crypto;
pub mod db;
pub mod error;
pub mod models;
pub mod snippet;
pub mod sshconfig;
pub mod vault;

pub use error::{Error, Result};

/// Current time as milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// New random identifier (UUID v4, hyphenated string form).
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
