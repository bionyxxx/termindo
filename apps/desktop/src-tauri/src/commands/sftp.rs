//! SFTP browser, transfers and remote editing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use termindo_ssh::sftp::{join_remote, RemoteEntry, SftpClient};

use crate::commands::ssh::{connect_host, resolve_target, ConnectTarget};
use crate::error::{CmdError, CmdResult};
use crate::state::{AppState, SftpEntry};
use crate::transfers::{self, Direction, TransferInfo, TransferState};

const MAX_EDIT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpOpened {
    pub home: String,
    pub start_dir: String,
    pub target: String,
}

#[tauri::command]
pub async fn sftp_open(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    target: ConnectTarget,
) -> CmdResult<SftpOpened> {
    let host = resolve_target(&state, &target)?;
    let (conn, _log) = connect_host(&app, &host, &target).await?;
    let conn = Arc::new(conn);
    let client = Arc::new(SftpClient::open(&conn).await?);
    let home = client.home_dir().await.unwrap_or_else(|_| "/".into());
    let start_dir = match &host.options.sftp_start_dir {
        Some(d) if !d.is_empty() => client
            .canonicalize(d)
            .await
            .unwrap_or_else(|_| home.clone()),
        _ => home.clone(),
    };
    let target_str = conn.target().to_string();
    let entry = Arc::new(SftpEntry {
        conn,
        client,
        edits: Mutex::new(HashMap::new()),
    });
    if let Some(old) = state.sftp.lock().unwrap().insert(sftp_id, entry) {
        stop_edits(&old);
    }
    Ok(SftpOpened {
        home,
        start_dir,
        target: target_str,
    })
}

fn stop_edits(entry: &SftpEntry) {
    for flag in entry.edits.lock().unwrap().values() {
        flag.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn sftp_close(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
) -> CmdResult<()> {
    let entry = state.sftp.lock().unwrap().remove(&sftp_id);
    state.transfers.cancel_session(&app, &sftp_id);
    if let Some(e) = entry {
        stop_edits(&e);
        e.conn.disconnect().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> CmdResult<Vec<RemoteEntry>> {
    let e = state.sftp_entry(&sftp_id)?;
    Ok(e.client.list(&path).await?)
}

#[tauri::command]
pub async fn sftp_realpath(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> CmdResult<String> {
    let e = state.sftp_entry(&sftp_id)?;
    Ok(e.client.canonicalize(&path).await?)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> CmdResult<()> {
    Ok(state.sftp_entry(&sftp_id)?.client.mkdir(&path).await?)
}

#[tauri::command]
pub async fn sftp_create_file(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
) -> CmdResult<()> {
    Ok(state
        .sftp_entry(&sftp_id)?
        .client
        .create_file(&path)
        .await?)
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    sftp_id: String,
    from: String,
    to: String,
) -> CmdResult<()> {
    Ok(state
        .sftp_entry(&sftp_id)?
        .client
        .rename(&from, &to)
        .await?)
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    sftp_id: String,
    paths: Vec<String>,
) -> CmdResult<()> {
    let e = state.sftp_entry(&sftp_id)?;
    for p in paths {
        if p == "/" || p.is_empty() {
            return Err(CmdError::invalid("refusing to delete the root directory"));
        }
        e.client.remove(&p).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    sftp_id: String,
    path: String,
    mode: u32,
) -> CmdResult<()> {
    Ok(state
        .sftp_entry(&sftp_id)?
        .client
        .chmod(&path, mode)
        .await?)
}

// -- local file system (left pane) ----------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: Option<u64>,
}

#[tauri::command]
pub fn local_home() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".into())
}

#[tauri::command]
pub fn local_list(path: String, show_hidden: Option<bool>) -> CmdResult<Vec<LocalEntry>> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(&path)? {
        let Ok(e) = e else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        if !show_hidden.unwrap_or(false) && name.starts_with('.') {
            continue;
        }
        let Ok(meta) = std::fs::metadata(e.path()) else {
            continue;
        };
        out.push(LocalEntry {
            path: e.path().to_string_lossy().into_owned(),
            name,
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub fn local_parent(path: String) -> String {
    Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(path)
}

// -- transfers ---------------------------------------------------------------------------------

fn new_transfer(
    sftp_id: &str,
    direction: Direction,
    local: &Path,
    remote: &str,
    size: u64,
    priority: i32,
) -> TransferInfo {
    let name = match direction {
        Direction::Upload => local
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default(),
        Direction::Download => remote.rsplit('/').next().unwrap_or(remote).to_string(),
    };
    TransferInfo {
        id: uuid::Uuid::new_v4().to_string(),
        sftp_id: sftp_id.to_string(),
        direction,
        local_path: local.to_string_lossy().into_owned(),
        remote_path: remote.to_string(),
        name,
        size,
        transferred: 0,
        state: TransferState::Queued,
        error: None,
        priority,
        created_at: termindo_core::now_ms(),
        speed: 0,
    }
}

fn walk_local(root: &Path) -> std::io::Result<Vec<(PathBuf, String, Option<u64>)>> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        for e in std::fs::read_dir(&dir)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            let ft = e.file_type()?;
            if ft.is_dir() {
                out.push((e.path(), child_rel.clone(), None));
                stack.push((e.path(), child_rel));
            } else if ft.is_file() {
                out.push((e.path(), child_rel, Some(e.metadata()?.len())));
            }
        }
    }
    Ok(out)
}

/// Queue uploads of local files/folders into `remote_dir`.
#[tauri::command]
pub async fn transfer_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    priority: Option<i32>,
) -> CmdResult<Vec<TransferInfo>> {
    let entry = state.sftp_entry(&sftp_id)?;
    let priority = priority.unwrap_or(0);
    let mut queued = Vec::new();
    for lp in local_paths {
        let local = PathBuf::from(&lp);
        let name = local
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .ok_or_else(|| CmdError::invalid("bad path"))?;
        let meta = std::fs::metadata(&local)?;
        let remote_root = join_remote(&remote_dir, &name);
        if meta.is_dir() {
            entry.client.mkdir_all(&remote_root).await?;
            for (path, rel, size) in walk_local(&local)? {
                let remote = join_remote(&remote_root, &rel);
                match size {
                    None => entry.client.mkdir_all(&remote).await?,
                    Some(size) => queued.push(state.transfers.enqueue(
                        &app,
                        new_transfer(&sftp_id, Direction::Upload, &path, &remote, size, priority),
                    )),
                }
            }
        } else {
            queued.push(state.transfers.enqueue(
                &app,
                new_transfer(
                    &sftp_id,
                    Direction::Upload,
                    &local,
                    &remote_root,
                    meta.len(),
                    priority,
                ),
            ));
        }
    }
    transfers::pump(&app);
    Ok(queued)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRef {
    pub path: String,
    pub is_dir: bool,
}

/// Queue downloads of remote files/folders into `local_dir`.
#[tauri::command]
pub async fn transfer_download(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    items: Vec<RemoteRef>,
    local_dir: String,
    priority: Option<i32>,
) -> CmdResult<Vec<TransferInfo>> {
    let entry = state.sftp_entry(&sftp_id)?;
    let priority = priority.unwrap_or(0);
    let mut queued = Vec::new();
    for item in items {
        let name = item
            .path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("download")
            .to_string();
        let local_root = Path::new(&local_dir).join(&name);
        if item.is_dir {
            std::fs::create_dir_all(&local_root)?;
            for (remote, rel, size) in entry.client.walk(&item.path).await? {
                let local = local_root.join(&rel);
                match size {
                    None => std::fs::create_dir_all(&local)?,
                    Some(size) => queued.push(state.transfers.enqueue(
                        &app,
                        new_transfer(
                            &sftp_id,
                            Direction::Download,
                            &local,
                            &remote,
                            size,
                            priority,
                        ),
                    )),
                }
            }
        } else {
            let size = entry
                .client
                .stat(&item.path)
                .await
                .map(|s| s.size)
                .unwrap_or(0);
            queued.push(state.transfers.enqueue(
                &app,
                new_transfer(
                    &sftp_id,
                    Direction::Download,
                    &local_root,
                    &item.path,
                    size,
                    priority,
                ),
            ));
        }
    }
    transfers::pump(&app);
    Ok(queued)
}

#[tauri::command]
pub fn transfers_list(state: State<'_, AppState>) -> Vec<TransferInfo> {
    state.transfers.list()
}

#[tauri::command]
pub fn transfer_pause(app: AppHandle, state: State<'_, AppState>, id: String) {
    state.transfers.pause(&app, &id);
}

#[tauri::command]
pub fn transfer_resume(app: AppHandle, state: State<'_, AppState>, id: String) {
    state.transfers.resume(&app, &id);
}

#[tauri::command]
pub fn transfer_cancel(app: AppHandle, state: State<'_, AppState>, id: String) {
    state.transfers.cancel(&app, &id);
}

#[tauri::command]
pub fn transfer_set_priority(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    priority: i32,
) {
    state.transfers.set_priority(&app, &id, priority);
    transfers::pump(&app);
}

#[tauri::command]
pub fn transfers_clear(state: State<'_, AppState>) {
    state.transfers.clear_finished();
}

// -- remote edit -------------------------------------------------------------------------------

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Download a remote file to a private temp dir, open it in the system editor,
/// and upload it back every time it is saved (until the SFTP tab is closed).
#[tauri::command]
pub async fn sftp_edit(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    remote_path: String,
) -> CmdResult<String> {
    let entry = state.sftp_entry(&sftp_id)?;
    let data = entry.client.read_file(&remote_path, MAX_EDIT_BYTES).await?;
    let name = remote_path.rsplit('/').next().unwrap_or("file").to_string();
    let dir = state
        .temp_dir()
        .join("edit")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let local = dir.join(&name);
    std::fs::write(&local, &data)?;

    // Replace any existing watcher for this file.
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(old) = entry
        .edits
        .lock()
        .unwrap()
        .insert(remote_path.clone(), stop.clone())
    {
        old.store(true, Ordering::SeqCst);
    }

    app.opener()
        .open_path(local.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| CmdError::new("open_failed", format!("could not open an editor: {e}")))?;

    let watch_app = app.clone();
    let watch_local = local.clone();
    let watch_remote = remote_path.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = mtime(&watch_local);
        while !stop.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(800)).await;
            let now = mtime(&watch_local);
            if now.is_none() || now == last {
                continue;
            }
            last = now;
            // Give editors that write in several steps a moment to finish.
            tokio::time::sleep(Duration::from_millis(250)).await;
            let result = match std::fs::read(&watch_local) {
                Ok(bytes) => entry
                    .client
                    .write_file(&watch_remote, &bytes)
                    .await
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e.to_string()),
            };
            let _ = watch_app.emit(
                "sftp-edit",
                json!({
                    "sftpId": sftp_id,
                    "remotePath": watch_remote,
                    "ok": result.is_ok(),
                    "error": result.err(),
                }),
            );
        }
        let _ = std::fs::remove_dir_all(watch_local.parent().unwrap_or(&watch_local));
    });
    Ok(local.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn sftp_edit_stop(
    state: State<'_, AppState>,
    sftp_id: String,
    remote_path: String,
) -> CmdResult<()> {
    let entry = state.sftp_entry(&sftp_id)?;
    if let Some(flag) = entry.edits.lock().unwrap().remove(&remote_path) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Open a downloaded file with the default application.
#[tauri::command]
pub fn open_local(app: AppHandle, path: String) -> CmdResult<()> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| CmdError::new("open_failed", e.to_string()))
}
