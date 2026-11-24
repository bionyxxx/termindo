use thiserror::Error;

pub type Result<T, E = SshError> = std::result::Result<T, E>;

#[derive(Debug, Error)]
pub enum SshError {
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("connection timed out")]
    Timeout,
    #[error("host key rejected for {0}")]
    HostKeyRejected(String),
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("ssh: {0}")]
    Ssh(#[from] russh::Error),
    #[error("key: {0}")]
    Key(#[from] russh::keys::Error),
    #[error("sftp: {0}")]
    Sftp(#[from] russh_sftp::client::error::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Other(String),
}
