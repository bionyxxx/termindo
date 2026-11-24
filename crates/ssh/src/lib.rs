//! Termindo SSH layer built on `russh` (pure Rust, async).
//!
//! * [`client`]: connection setup, host key verification, authentication, ProxyJump
//! * [`shell`]: interactive PTY shell channels
//! * [`sftp`]: SFTP file operations and resumable transfers
//! * [`keys`]: key generation and parsing

pub mod client;
pub mod error;
pub mod keys;
pub mod sftp;
pub mod shell;

pub use client::{
    AuthMethod, ConnectConfig, HostKeyInfo, Interaction, KbdPrompt, KbdRequest, SshConnection,
};
pub use error::{Result, SshError};
pub use shell::{ShellEvent, ShellHandle, ShellOptions};
