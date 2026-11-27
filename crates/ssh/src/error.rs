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
    /// `hop` 1 is the target's own jump host, 2 the jump host of that one, and so on.
    #[error("authentication failed on jump host {host}: {reason}")]
    JumpAuth {
        hop: usize,
        host: String,
        reason: String,
    },
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

impl SshError {
    /// Label an error from connecting `jump`, as seen by the connection behind it.
    pub(crate) fn via_jump(self, jump: String) -> Self {
        match self {
            SshError::Auth(reason) => SshError::JumpAuth {
                hop: 1,
                host: jump,
                reason,
            },
            SshError::JumpAuth { hop, host, reason } => SshError::JumpAuth {
                hop: hop + 1,
                host,
                reason,
            },
            other => other,
        }
    }
}
