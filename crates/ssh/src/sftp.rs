//! SFTP client: directory listing, file management and resumable transfers.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::client::SshConnection;
use crate::error::{Result, SshError};

const CHUNK: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix permission bits (lower 12 bits of st_mode).
    pub permissions: Option<u32>,
    /// Seconds since epoch.
    pub mtime: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

/// Flags shared with a running transfer so the UI can pause or cancel it.
#[derive(Debug, Default)]
pub struct TransferControl {
    cancelled: AtomicBool,
}

impl TransferControl {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    /// Stop the transfer; the partial file is kept so it can be resumed.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// Version of the source file that a partial destination was copied from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceStamp {
    size: u64,
    modified: Option<SystemTime>,
}

pub fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() || dir == "." {
        name.to_string()
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

pub fn parent_remote(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() && path.starts_with('/') {
        return "/".to_string();
    }
    match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => trimmed[..i].to_string(),
        None => ".".to_string(),
    }
}

pub struct SftpClient {
    session: SftpSession,
}

impl SftpClient {
    pub async fn open(conn: &SshConnection) -> Result<Self> {
        let channel = conn.handle().channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let session = SftpSession::new(channel.into_stream()).await?;
        Ok(Self { session })
    }

    pub async fn home_dir(&self) -> Result<String> {
        Ok(self.session.canonicalize(".").await?)
    }

    pub async fn canonicalize(&self, path: &str) -> Result<String> {
        Ok(self.session.canonicalize(path).await?)
    }

    fn entry(&self, dir: &str, name: String, attrs: &FileAttributes) -> RemoteEntry {
        let ft = attrs.file_type();
        RemoteEntry {
            path: join_remote(dir, &name),
            name,
            is_dir: ft.is_dir(),
            is_symlink: ft.is_symlink(),
            size: attrs.size.unwrap_or(0),
            permissions: attrs.permissions.map(|p| p & 0o7777),
            mtime: attrs.mtime,
            owner: attrs
                .user
                .clone()
                .or_else(|| attrs.uid.map(|u| u.to_string())),
            group: attrs
                .group
                .clone()
                .or_else(|| attrs.gid.map(|g| g.to_string())),
        }
    }

    /// List a directory (without `.` and `..`). Symlinks to directories are reported as directories.
    pub async fn list(&self, dir: &str) -> Result<Vec<RemoteEntry>> {
        let mut out = Vec::new();
        for e in self.session.read_dir(dir).await? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let mut entry = self.entry(dir, name, &e.metadata());
            if entry.is_symlink {
                if let Ok(target) = self.session.metadata(entry.path.as_str()).await {
                    entry.is_dir = target.file_type().is_dir();
                    entry.size = target.size.unwrap_or(entry.size);
                }
            }
            out.push(entry);
        }
        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    pub async fn stat(&self, path: &str) -> Result<RemoteEntry> {
        let attrs = self.session.metadata(path).await?;
        let name = path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(path)
            .to_string();
        let mut e = self.entry(&parent_remote(path), name, &attrs);
        e.path = path.to_string();
        Ok(e)
    }

    pub async fn exists(&self, path: &str) -> Result<bool> {
        Ok(self.session.try_exists(path).await?)
    }

    pub async fn mkdir(&self, path: &str) -> Result<()> {
        Ok(self.session.create_dir(path).await?)
    }

    /// Create directories along `path` that don't exist yet.
    pub async fn mkdir_all(&self, path: &str) -> Result<()> {
        let absolute = path.starts_with('/');
        let mut cur = String::new();
        for part in path.split('/').filter(|p| !p.is_empty()) {
            cur = if cur.is_empty() {
                if absolute {
                    format!("/{part}")
                } else {
                    part.to_string()
                }
            } else {
                format!("{cur}/{part}")
            };
            if !self.session.try_exists(cur.as_str()).await? {
                self.session.create_dir(cur.as_str()).await?;
            }
        }
        Ok(())
    }

    pub async fn create_file(&self, path: &str) -> Result<()> {
        let mut f = self
            .session
            .open_with_flags(
                path,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await?;
        f.shutdown().await?;
        Ok(())
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        Ok(self.session.rename(from, to).await?)
    }

    pub async fn chmod(&self, path: &str, mode: u32) -> Result<()> {
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode & 0o7777);
        Ok(self.session.set_metadata(path, attrs).await?)
    }

    /// Remove a file, or a directory recursively.
    pub async fn remove(&self, path: &str) -> Result<()> {
        let attrs = self.session.symlink_metadata(path).await?;
        if attrs.file_type().is_dir() {
            for e in self.list_raw(path).await? {
                Box::pin(self.remove(&e.path)).await?;
            }
            self.session.remove_dir(path).await?;
        } else {
            self.session.remove_file(path).await?;
        }
        Ok(())
    }

    /// Like [`list`] but does not follow symlinks (used for safe recursive delete).
    async fn list_raw(&self, dir: &str) -> Result<Vec<RemoteEntry>> {
        let mut out = Vec::new();
        for e in self.session.read_dir(dir).await? {
            let name = e.file_name();
            if name != "." && name != ".." {
                out.push(self.entry(dir, name, &e.metadata()));
            }
        }
        Ok(out)
    }

    /// All files below `dir` as `(remote_path, relative_path, size)`; directories as size `None`.
    pub async fn walk(&self, dir: &str) -> Result<Vec<(String, String, Option<u64>)>> {
        let mut out = Vec::new();
        let mut stack = vec![(dir.to_string(), String::new())];
        while let Some((abs, rel)) = stack.pop() {
            for e in self.list_raw(&abs).await? {
                let child_rel = if rel.is_empty() {
                    e.name.clone()
                } else {
                    format!("{rel}/{}", e.name)
                };
                if e.is_dir {
                    out.push((e.path.clone(), child_rel.clone(), None));
                    stack.push((e.path, child_rel));
                } else if !e.is_symlink {
                    out.push((e.path, child_rel, Some(e.size)));
                }
            }
        }
        Ok(out)
    }

    pub async fn read_file(&self, path: &str, max_bytes: u64) -> Result<Vec<u8>> {
        let attrs = self.session.metadata(path).await?;
        if attrs.size.unwrap_or(0) > max_bytes {
            return Err(SshError::Other(format!(
                "file is larger than {} bytes",
                max_bytes
            )));
        }
        Ok(self.session.read(path).await?)
    }

    pub async fn write_file(&self, path: &str, data: &[u8]) -> Result<()> {
        let mut f = self
            .session
            .open_with_flags(
                path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await?;
        f.write_all(data).await?;
        f.shutdown().await?;
        Ok(())
    }

    /// Download `remote` to `local`. `progress(done, total)` is called after every chunk.
    /// Returns bytes transferred in total.
    ///
    /// `partial` carries resume state between attempts of one transfer: pass `None` the first
    /// time, which overwrites `local`. It is set once `local` holds data from this transfer;
    /// passing it back continues from the size of `local`, unless `remote` has changed since.
    pub async fn download<F>(
        &self,
        remote: &str,
        local: &Path,
        partial: &mut Option<SourceStamp>,
        control: &TransferControl,
        mut progress: F,
    ) -> Result<u64>
    where
        F: FnMut(u64, u64) + Send,
    {
        let attrs = self.session.metadata(remote).await?;
        let total = attrs.size.unwrap_or(0);
        let source = SourceStamp {
            size: total,
            modified: attrs
                .mtime
                .map(|s| UNIX_EPOCH + Duration::from_secs(s.into())),
        };
        if let Some(parent) = local.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut offset = 0u64;
        if *partial == Some(source) {
            if let Ok(meta) = tokio::fs::metadata(local).await {
                // A local file longer than the remote one is not our partial: start over.
                if meta.len() <= total {
                    offset = meta.len();
                }
            }
        }
        // Open the source first, so a failure here leaves `local` untouched.
        let mut src = self.session.open(remote).await?;
        let mut out = if offset > 0 {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(local)
                .await?
        } else {
            tokio::fs::File::create(local).await?
        };
        *partial = Some(source);

        if offset > 0 {
            src.seek(std::io::SeekFrom::Start(offset)).await?;
        }
        progress(offset, total);
        let mut buf = vec![0u8; CHUNK];
        let mut done = offset;
        loop {
            if control.is_cancelled() {
                out.flush().await?;
                return Err(SshError::Cancelled);
            }
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).await?;
            done += n as u64;
            progress(done, total);
        }
        out.flush().await?;
        out.sync_all().await.ok();
        if done != total && total != 0 {
            return Err(SshError::Other(format!(
                "size mismatch after download: {done} of {total} bytes"
            )));
        }
        Ok(done)
    }

    /// Upload `local` to `remote`. `partial` works as in [`SftpClient::download`]: `None`
    /// overwrites `remote`, and the value set by an earlier attempt continues after the
    /// remote file's current size, unless `local` has changed since.
    pub async fn upload<F>(
        &self,
        local: &Path,
        remote: &str,
        partial: &mut Option<SourceStamp>,
        control: &TransferControl,
        mut progress: F,
    ) -> Result<u64>
    where
        F: FnMut(u64, u64) + Send,
    {
        let mut src = tokio::fs::File::open(local).await?;
        let meta = src.metadata().await?;
        let total = meta.len();
        let source = SourceStamp {
            size: total,
            modified: meta.modified().ok(),
        };

        let mut offset = 0u64;
        if *partial == Some(source) {
            if let Ok(attrs) = self.session.metadata(remote).await {
                let existing = attrs.size.unwrap_or(0);
                if existing <= total {
                    offset = existing;
                }
            }
        }
        let mut dst = if offset > 0 {
            let mut f = self
                .session
                .open_with_flags(remote, OpenFlags::WRITE)
                .await?;
            f.seek(std::io::SeekFrom::Start(offset)).await?;
            f
        } else {
            self.session
                .open_with_flags(
                    remote,
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await?
        };
        *partial = Some(source);
        if offset > 0 {
            src.seek(std::io::SeekFrom::Start(offset)).await?;
        }

        progress(offset, total);
        let mut buf = vec![0u8; CHUNK];
        let mut done = offset;
        loop {
            if control.is_cancelled() {
                let _ = dst.shutdown().await;
                return Err(SshError::Cancelled);
            }
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
            done += n as u64;
            progress(done, total);
        }
        dst.flush().await?;
        dst.shutdown().await?;

        let remote_size = self.session.metadata(remote).await?.size.unwrap_or(0);
        if remote_size != total {
            return Err(SshError::Other(format!(
                "size mismatch after upload: remote has {remote_size} of {total} bytes"
            )));
        }
        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(join_remote("/", "a"), "/a");
        assert_eq!(join_remote("/home/u", "a"), "/home/u/a");
        assert_eq!(join_remote(".", "a"), "a");
        assert_eq!(parent_remote("/home/u/a"), "/home/u");
        assert_eq!(parent_remote("/home"), "/");
        assert_eq!(parent_remote("/"), "/");
        assert_eq!(parent_remote("a"), ".");
    }
}
