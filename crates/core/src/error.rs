use thiserror::Error;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("wrong master password or corrupted vault")]
    WrongPassword,
    #[error("vault is locked")]
    VaultLocked,
    #[error("vault is not initialized")]
    VaultNotInitialized,
    #[error("vault is already initialized")]
    VaultAlreadyInitialized,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
