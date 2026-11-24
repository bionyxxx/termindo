//! Sync server wire protocol (JSON over HTTPS, `/api/v1`).
//!
//! All binary values are standard base64 strings. The server never receives the
//! master password, the master key or the DEK: only
//! * `auth_hash`: HKDF(master key, "termindo/auth/v1"), re-hashed with Argon2id server-side
//! * `wrapped_dek`: the DEK sealed with a key the server cannot derive
//! * record blobs sealed with the DEK

use serde::{Deserialize, Serialize};
use termindo_core::crypto::KdfParams;

pub const API_PREFIX: &str = "/api/v1";
/// Maximum records accepted in a single push.
pub const MAX_PUSH: usize = 500;
/// Maximum size of one encrypted record blob (base64 characters).
pub const MAX_BLOB_LEN: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
    /// Machine readable code, e.g. `invalid_credentials`, `email_taken`, `unauthorized`.
    pub code: String,
}

// -- auth -------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreloginRequest {
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreloginResponse {
    pub kdf_salt: String,
    pub kdf: KdfParams,
}

/// Key material stored on the server (all opaque to it).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountKeys {
    pub kdf_salt: String,
    pub kdf: KdfParams,
    pub wrapped_dek: String,
    pub wrapped_dek_recovery: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub auth_hash: String,
    pub keys: AccountKeys,
    /// HKDF(recovery key, "termindo/recovery-auth/v1") — lets the recovery key authenticate.
    pub recovery_auth_hash: Option<String>,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub auth_hash: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    /// Access token lifetime in seconds.
    pub expires_in: i64,
    pub user_id: String,
    pub device_id: String,
    pub email: String,
    pub keys: AccountKeys,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangePasswordRequest {
    pub current_auth_hash: String,
    pub new_auth_hash: String,
    pub kdf_salt: String,
    pub kdf: KdfParams,
    pub wrapped_dek: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoverChallengeRequest {
    pub email: String,
    pub recovery_auth_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoverChallengeResponse {
    pub wrapped_dek_recovery: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoverRequest {
    pub email: String,
    pub recovery_auth_hash: String,
    pub new_auth_hash: String,
    pub kdf_salt: String,
    pub kdf: KdfParams,
    pub wrapped_dek: String,
    pub device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub current: bool,
}

// -- sync -------------------------------------------------------------------

/// A record as stored by the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteRecord {
    pub id: String,
    /// Server-assigned, strictly increasing per account. Used as the pull cursor.
    pub seq: i64,
    /// Client-assigned modification time (ms). Used for last-write-wins.
    pub updated_at: i64,
    pub deleted: bool,
    /// Encrypted [`crate::envelope::RecordPayload`].
    pub blob: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullResponse {
    pub records: Vec<RemoteRecord>,
    /// Highest `seq` included; pass as `since` on the next pull.
    pub cursor: i64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushRecord {
    pub id: String,
    pub updated_at: i64,
    pub deleted: bool,
    pub blob: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushRequest {
    pub records: Vec<PushRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushResponse {
    /// Ids stored by the server.
    pub accepted: Vec<String>,
    /// Ids the server already had a newer version of (pull to get it).
    pub rejected: Vec<String>,
}

/// Last-write-wins decision used by the server for a pushed record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushDecision {
    /// Newer than what the server has: store it.
    Store,
    /// Same version the server already has (e.g. a retried push): acknowledge, change nothing.
    AlreadyStored,
    /// The server has a newer version: reject; the client will receive it on pull.
    Reject,
}

pub fn decide_push(incoming_updated_at: i64, existing_updated_at: Option<i64>) -> PushDecision {
    match existing_updated_at {
        None => PushDecision::Store,
        Some(existing) if incoming_updated_at > existing => PushDecision::Store,
        Some(existing) if incoming_updated_at == existing => PushDecision::AlreadyStored,
        Some(_) => PushDecision::Reject,
    }
}
