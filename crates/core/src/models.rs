//! Data model. Every synced entity implements [`Entity`], which gives the
//! database layer and the sync engine a single generic code path.

use rusqlite::types::Value;
use rusqlite::Row;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// A record stored locally and synchronised (encrypted) across devices.
pub trait Entity: Serialize + DeserializeOwned + Clone + Send + 'static {
    const TABLE: &'static str;
    /// Kind tag used inside encrypted sync payloads.
    const KIND: &'static str;
    /// Column names in the order produced by [`Entity::to_values`] / read by [`Entity::from_row`].
    const COLUMNS: &'static [&'static str];

    fn id(&self) -> &str;
    fn updated_at(&self) -> i64;
    fn set_updated_at(&mut self, t: i64);
    fn deleted_at(&self) -> Option<i64>;
    fn set_deleted_at(&mut self, t: Option<i64>);
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self>;
    fn to_values(&self) -> Vec<Value>;
}

fn opt_text(v: &Option<String>) -> Value {
    v.clone().map(Value::Text).unwrap_or(Value::Null)
}

fn opt_int(v: Option<i64>) -> Value {
    v.map(Value::Integer).unwrap_or(Value::Null)
}

fn json_col<T: Serialize>(v: &T) -> Value {
    Value::Text(serde_json::to_string(v).unwrap_or_else(|_| "null".into()))
}

fn from_json_col<T: DeserializeOwned + Default>(s: String) -> T {
    serde_json::from_str(&s).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

impl Entity for Group {
    const TABLE: &'static str = "groups";
    const KIND: &'static str = "group";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "name",
        "parent_id",
        "icon",
        "color",
        "sort_order",
        "updated_at",
        "deleted_at",
    ];

    fn id(&self) -> &str {
        &self.id
    }
    fn updated_at(&self) -> i64 {
        self.updated_at
    }
    fn set_updated_at(&mut self, t: i64) {
        self.updated_at = t
    }
    fn deleted_at(&self) -> Option<i64> {
        self.deleted_at
    }
    fn set_deleted_at(&mut self, t: Option<i64>) {
        self.deleted_at = t
    }

    fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            name: r.get(1)?,
            parent_id: r.get(2)?,
            icon: r.get(3)?,
            color: r.get(4)?,
            sort_order: r.get(5)?,
            updated_at: r.get(6)?,
            deleted_at: r.get(7)?,
        })
    }

    fn to_values(&self) -> Vec<Value> {
        vec![
            Value::Text(self.id.clone()),
            Value::Text(self.name.clone()),
            opt_text(&self.parent_id),
            opt_text(&self.icon),
            opt_text(&self.color),
            Value::Integer(self.sort_order),
            Value::Integer(self.updated_at),
            opt_int(self.deleted_at),
        ]
    }
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthType {
    #[default]
    Password,
    Key,
    Agent,
    Interactive,
}

impl AuthType {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthType::Password => "password",
            AuthType::Key => "key",
            AuthType::Agent => "agent",
            AuthType::Interactive => "interactive",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "key" => AuthType::Key,
            "agent" => AuthType::Agent,
            "interactive" => AuthType::Interactive,
            _ => AuthType::Password,
        }
    }
}

/// Per-host options stored as JSON (forward compatible: unknown fields are kept).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostOptions {
    /// Keepalive interval in seconds (0 = disabled). Default 30.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keepalive_secs: Option<u32>,
    /// Reconnect automatically when the connection drops.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_reconnect: Option<bool>,
    /// TERM value requested for the PTY. Default `xterm-256color`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub term_type: Option<String>,
    /// Snippet executed right after the shell opens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_snippet_id: Option<String>,
    /// Environment variables requested for the session.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<(String, String)>,
    /// Accent color for the tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Initial remote directory for SFTP.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sftp_start_dir: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub group_id: Option<String>,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth_type: AuthType,
    pub credential_id: Option<String>,
    pub jump_host_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub options: HostOptions,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

impl Host {
    pub fn display_name(&self) -> &str {
        if self.label.is_empty() {
            &self.hostname
        } else {
            &self.label
        }
    }
}

impl Entity for Host {
    const TABLE: &'static str = "hosts";
    const KIND: &'static str = "host";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "group_id",
        "label",
        "hostname",
        "port",
        "username",
        "auth_type",
        "credential_id",
        "jump_host_id",
        "tags",
        "options",
        "notes",
        "updated_at",
        "deleted_at",
    ];

    fn id(&self) -> &str {
        &self.id
    }
    fn updated_at(&self) -> i64 {
        self.updated_at
    }
    fn set_updated_at(&mut self, t: i64) {
        self.updated_at = t
    }
    fn deleted_at(&self) -> Option<i64> {
        self.deleted_at
    }
    fn set_deleted_at(&mut self, t: Option<i64>) {
        self.deleted_at = t
    }

    fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            group_id: r.get(1)?,
            label: r.get(2)?,
            hostname: r.get(3)?,
            port: r.get::<_, i64>(4)? as u16,
            username: r.get(5)?,
            auth_type: AuthType::parse(&r.get::<_, String>(6)?),
            credential_id: r.get(7)?,
            jump_host_id: r.get(8)?,
            tags: from_json_col(r.get(9)?),
            options: from_json_col(r.get(10)?),
            notes: r.get(11)?,
            updated_at: r.get(12)?,
            deleted_at: r.get(13)?,
        })
    }

    fn to_values(&self) -> Vec<Value> {
        vec![
            Value::Text(self.id.clone()),
            opt_text(&self.group_id),
            Value::Text(self.label.clone()),
            Value::Text(self.hostname.clone()),
            Value::Integer(self.port as i64),
            Value::Text(self.username.clone()),
            Value::Text(self.auth_type.as_str().into()),
            opt_text(&self.credential_id),
            opt_text(&self.jump_host_id),
            json_col(&self.tags),
            json_col(&self.options),
            Value::Text(self.notes.clone()),
            Value::Integer(self.updated_at),
            opt_int(self.deleted_at),
        ]
    }
}

// ---------------------------------------------------------------------------
// Credentials (passwords and private keys)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    Password,
    PrivateKey,
}

impl CredentialKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            CredentialKind::Password => "password",
            CredentialKind::PrivateKey => "private_key",
        }
    }
    pub fn parse(s: &str) -> Self {
        if s == "private_key" {
            CredentialKind::PrivateKey
        } else {
            CredentialKind::Password
        }
    }
}

/// Stored credential. `data_enc` is the [`CredentialSecret`] JSON sealed with the DEK.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub label: String,
    pub kind: CredentialKind,
    /// OpenSSH public key line, for private keys.
    pub public_key: Option<String>,
    #[serde(with = "b64_bytes")]
    pub data_enc: Vec<u8>,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

impl Entity for Credential {
    const TABLE: &'static str = "credentials";
    const KIND: &'static str = "credential";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "label",
        "kind",
        "public_key",
        "data_enc",
        "updated_at",
        "deleted_at",
    ];

    fn id(&self) -> &str {
        &self.id
    }
    fn updated_at(&self) -> i64 {
        self.updated_at
    }
    fn set_updated_at(&mut self, t: i64) {
        self.updated_at = t
    }
    fn deleted_at(&self) -> Option<i64> {
        self.deleted_at
    }
    fn set_deleted_at(&mut self, t: Option<i64>) {
        self.deleted_at = t
    }

    fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            label: r.get(1)?,
            kind: CredentialKind::parse(&r.get::<_, String>(2)?),
            public_key: r.get(3)?,
            data_enc: r.get(4)?,
            updated_at: r.get(5)?,
            deleted_at: r.get(6)?,
        })
    }

    fn to_values(&self) -> Vec<Value> {
        vec![
            Value::Text(self.id.clone()),
            Value::Text(self.label.clone()),
            Value::Text(self.kind.as_str().into()),
            opt_text(&self.public_key),
            Value::Blob(self.data_enc.clone()),
            Value::Integer(self.updated_at),
            opt_int(self.deleted_at),
        ]
    }
}

/// Decrypted secret material of a credential. Wiped from memory on drop.
#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSecret {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// OpenSSH / PEM encoded private key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

impl std::fmt::Debug for CredentialSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CredentialSecret(..)")
    }
}

/// Credential as shown to the UI (no secret material).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInfo {
    pub id: String,
    pub label: String,
    pub kind: CredentialKind,
    pub public_key: Option<String>,
    pub updated_at: i64,
}

impl From<&Credential> for CredentialInfo {
    fn from(c: &Credential) -> Self {
        Self {
            id: c.id.clone(),
            label: c.label.clone(),
            kind: c.kind,
            public_key: c.public_key.clone(),
            updated_at: c.updated_at,
        }
    }
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub body: String,
    pub hotkey: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

impl Entity for Snippet {
    const TABLE: &'static str = "snippets";
    const KIND: &'static str = "snippet";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "name",
        "body",
        "hotkey",
        "tags",
        "updated_at",
        "deleted_at",
    ];

    fn id(&self) -> &str {
        &self.id
    }
    fn updated_at(&self) -> i64 {
        self.updated_at
    }
    fn set_updated_at(&mut self, t: i64) {
        self.updated_at = t
    }
    fn deleted_at(&self) -> Option<i64> {
        self.deleted_at
    }
    fn set_deleted_at(&mut self, t: Option<i64>) {
        self.deleted_at = t
    }

    fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            name: r.get(1)?,
            body: r.get(2)?,
            hotkey: r.get(3)?,
            tags: from_json_col(r.get(4)?),
            updated_at: r.get(5)?,
            deleted_at: r.get(6)?,
        })
    }

    fn to_values(&self) -> Vec<Value> {
        vec![
            Value::Text(self.id.clone()),
            Value::Text(self.name.clone()),
            Value::Text(self.body.clone()),
            opt_text(&self.hotkey),
            json_col(&self.tags),
            Value::Integer(self.updated_at),
            opt_int(self.deleted_at),
        ]
    }
}

// ---------------------------------------------------------------------------
// Known hosts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    /// Deterministic: `kh:<host>:<port>` so devices converge on the same record.
    pub id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    /// Base64 public key blob (the second field of an OpenSSH public key line).
    pub key: String,
    /// `SHA256:...` fingerprint.
    pub fingerprint: String,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

impl KnownHost {
    pub fn make_id(host: &str, port: u16) -> String {
        format!("kh:{}:{}", host.to_ascii_lowercase(), port)
    }
}

impl Entity for KnownHost {
    const TABLE: &'static str = "known_hosts";
    const KIND: &'static str = "known_host";
    const COLUMNS: &'static [&'static str] = &[
        "id",
        "host",
        "port",
        "key_type",
        "key",
        "fingerprint",
        "updated_at",
        "deleted_at",
    ];

    fn id(&self) -> &str {
        &self.id
    }
    fn updated_at(&self) -> i64 {
        self.updated_at
    }
    fn set_updated_at(&mut self, t: i64) {
        self.updated_at = t
    }
    fn deleted_at(&self) -> Option<i64> {
        self.deleted_at
    }
    fn set_deleted_at(&mut self, t: Option<i64>) {
        self.deleted_at = t
    }

    fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            host: r.get(1)?,
            port: r.get::<_, i64>(2)? as u16,
            key_type: r.get(3)?,
            key: r.get(4)?,
            fingerprint: r.get(5)?,
            updated_at: r.get(6)?,
            deleted_at: r.get(7)?,
        })
    }

    fn to_values(&self) -> Vec<Value> {
        vec![
            Value::Text(self.id.clone()),
            Value::Text(self.host.clone()),
            Value::Integer(self.port as i64),
            Value::Text(self.key_type.clone()),
            Value::Text(self.key.clone()),
            Value::Text(self.fingerprint.clone()),
            Value::Integer(self.updated_at),
            opt_int(self.deleted_at),
        ]
    }
}

// ---------------------------------------------------------------------------
// Local-only records
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLog {
    pub id: i64,
    pub host_id: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostStats {
    pub host_id: String,
    pub connections: i64,
    pub failures: i64,
    pub last_connected_at: Option<i64>,
}

pub mod b64_bytes {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(s)
            .map_err(serde::de::Error::custom)
    }
}
