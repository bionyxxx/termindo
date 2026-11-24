//! Interactive PTY shell sessions.
//!
//! The channel is split into a read half (pumped by one task into the event
//! callback) and a write half (driven by a command queue), so heavy output
//! never blocks keystrokes and vice-versa.

use russh::{ChannelMsg, Pty};
use tokio::sync::mpsc;

use crate::client::SshConnection;
use crate::error::Result;

#[derive(Debug, Clone)]
pub struct ShellOptions {
    pub term: String,
    pub cols: u32,
    pub rows: u32,
    pub env: Vec<(String, String)>,
}

impl Default for ShellOptions {
    fn default() -> Self {
        Self {
            term: "xterm-256color".into(),
            cols: 80,
            rows: 24,
            env: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum ShellEvent {
    /// Terminal output (stdout and stderr interleaved, as a terminal would show).
    Data(Vec<u8>),
    /// The remote shell exited / the channel closed.
    Closed { exit_status: Option<u32> },
}

enum Cmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

/// Cheap, cloneable handle used to drive a running shell.
#[derive(Clone)]
pub struct ShellHandle {
    tx: mpsc::UnboundedSender<Cmd>,
}

impl ShellHandle {
    pub fn write(&self, data: impl Into<Vec<u8>>) -> bool {
        self.tx.send(Cmd::Data(data.into())).is_ok()
    }

    pub fn resize(&self, cols: u32, rows: u32) -> bool {
        self.tx.send(Cmd::Resize(cols, rows)).is_ok()
    }

    pub fn close(&self) {
        let _ = self.tx.send(Cmd::Close);
    }

    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

/// Open a PTY + shell on `conn`. `on_event` is invoked from a background task.
pub async fn open_shell<F>(
    conn: &SshConnection,
    opts: ShellOptions,
    mut on_event: F,
) -> Result<ShellHandle>
where
    F: FnMut(ShellEvent) + Send + 'static,
{
    let channel = conn.handle().channel_open_session().await?;
    for (k, v) in &opts.env {
        // Servers commonly refuse env vars not in AcceptEnv; that's not fatal.
        let _ = channel.set_env(false, k.clone(), v.clone()).await;
    }
    let modes = [
        (Pty::ECHO, 1),
        (Pty::TTY_OP_ISPEED, 14400),
        (Pty::TTY_OP_OSPEED, 14400),
    ];
    channel
        .request_pty(
            true,
            &opts.term,
            opts.cols.max(1),
            opts.rows.max(1),
            0,
            0,
            &modes,
        )
        .await?;
    channel.request_shell(true).await?;

    let (mut reader, writer) = channel.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();

    // Writer: keystrokes, resizes, close.
    tokio::spawn(async move {
        while let Some(cmd) = rx.recv().await {
            let res = match cmd {
                Cmd::Data(d) => writer.data_bytes(d).await,
                Cmd::Resize(c, r) => writer.window_change(c.max(1), r.max(1), 0, 0).await,
                Cmd::Close => {
                    let _ = writer.eof().await;
                    let _ = writer.close().await;
                    break;
                }
            };
            if let Err(e) = res {
                tracing::debug!("shell write failed: {e}");
                break;
            }
        }
    });

    // Reader: output and exit.
    tokio::spawn(async move {
        let mut exit_status = None;
        while let Some(msg) = reader.wait().await {
            match msg {
                ChannelMsg::Data { data } => on_event(ShellEvent::Data(data.to_vec())),
                ChannelMsg::ExtendedData { data, .. } => on_event(ShellEvent::Data(data.to_vec())),
                ChannelMsg::ExitStatus { exit_status: s } => exit_status = Some(s),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        on_event(ShellEvent::Closed { exit_status });
    });

    Ok(ShellHandle { tx })
}
