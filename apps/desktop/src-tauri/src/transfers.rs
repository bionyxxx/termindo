//! SFTP transfer queue: priorities, limited concurrency, pause/resume, retry.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use termindo_ssh::sftp::{SourceStamp, TransferControl};
use termindo_ssh::SshError;

use crate::state::AppState;

const MAX_CONCURRENT: usize = 3;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferState {
    Queued,
    Running,
    Paused,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub id: String,
    pub sftp_id: String,
    pub direction: Direction,
    pub local_path: String,
    pub remote_path: String,
    pub name: String,
    pub size: u64,
    pub transferred: u64,
    pub state: TransferState,
    pub error: Option<String>,
    /// Higher runs first.
    pub priority: i32,
    pub created_at: i64,
    /// Bytes per second (recent average).
    pub speed: u64,
}

struct Item {
    info: TransferInfo,
    control: Option<Arc<TransferControl>>,
    /// Set once the destination holds data from this transfer, so a retry can continue it.
    partial: Option<SourceStamp>,
}

#[derive(Default)]
pub struct TransferManager {
    items: Mutex<Vec<Item>>,
}

fn emit(app: &AppHandle, info: &TransferInfo) {
    let _ = app.emit("transfer-update", info);
}

impl TransferManager {
    pub fn list(&self) -> Vec<TransferInfo> {
        self.items
            .lock()
            .unwrap()
            .iter()
            .map(|i| i.info.clone())
            .collect()
    }

    pub fn enqueue(&self, app: &AppHandle, mut info: TransferInfo) -> TransferInfo {
        info.state = TransferState::Queued;
        let out = info.clone();
        self.items.lock().unwrap().push(Item {
            info,
            control: None,
            partial: None,
        });
        emit(app, &out);
        out
    }

    fn update<F: FnOnce(&mut Item)>(
        &self,
        app: &AppHandle,
        id: &str,
        f: F,
    ) -> Option<TransferInfo> {
        let mut items = self.items.lock().unwrap();
        let item = items.iter_mut().find(|i| i.info.id == id)?;
        f(item);
        let info = item.info.clone();
        drop(items);
        emit(app, &info);
        Some(info)
    }

    pub fn pause(&self, app: &AppHandle, id: &str) {
        self.update(app, id, |i| {
            if matches!(i.info.state, TransferState::Running | TransferState::Queued) {
                if let Some(c) = &i.control {
                    c.cancel();
                }
                i.info.state = TransferState::Paused;
                i.info.speed = 0;
            }
        });
    }

    pub fn resume(&self, app: &AppHandle, id: &str) {
        self.update(app, id, |i| {
            if matches!(i.info.state, TransferState::Paused | TransferState::Error) {
                i.info.state = TransferState::Queued;
                i.info.error = None;
            }
        });
        pump(app);
    }

    pub fn cancel(&self, app: &AppHandle, id: &str) {
        self.update(app, id, |i| {
            if let Some(c) = &i.control {
                c.cancel();
            }
            if !matches!(i.info.state, TransferState::Done) {
                i.info.state = TransferState::Cancelled;
                i.info.speed = 0;
            }
        });
    }

    pub fn set_priority(&self, app: &AppHandle, id: &str, priority: i32) {
        self.update(app, id, |i| i.info.priority = priority);
    }

    pub fn clear_finished(&self) {
        self.items
            .lock()
            .unwrap()
            .retain(|i| !matches!(i.info.state, TransferState::Done | TransferState::Cancelled));
    }

    /// Cancel everything belonging to a closed SFTP session.
    pub fn cancel_session(&self, app: &AppHandle, sftp_id: &str) {
        let ids: Vec<String> = self
            .items
            .lock()
            .unwrap()
            .iter()
            .filter(|i| {
                i.info.sftp_id == sftp_id
                    && !matches!(i.info.state, TransferState::Done | TransferState::Cancelled)
            })
            .map(|i| i.info.id.clone())
            .collect();
        for id in ids {
            self.cancel(app, &id);
        }
    }
}

/// Queued items that may start now, best first.
fn startable(items: &[Item]) -> Vec<usize> {
    let mut queued: Vec<usize> = items
        .iter()
        .enumerate()
        // A paused attempt keeps its control until it stops writing. Starting another one
        // before that would put two writers on the same file.
        .filter(|(_, i)| i.info.state == TransferState::Queued && i.control.is_none())
        .map(|(n, _)| n)
        .collect();
    queued.sort_by(|&a, &b| {
        items[b]
            .info
            .priority
            .cmp(&items[a].info.priority)
            .then(items[a].info.created_at.cmp(&items[b].info.created_at))
    });
    queued
}

/// Start queued transfers while below the concurrency limit.
pub fn pump(app: &AppHandle) {
    let state = app.state::<AppState>();
    let manager = state.transfers.clone();
    let mut to_start = Vec::new();
    {
        let mut items = manager.items.lock().unwrap();
        let running = items
            .iter()
            .filter(|i| i.info.state == TransferState::Running)
            .count();
        for idx in startable(&items)
            .into_iter()
            .take(MAX_CONCURRENT.saturating_sub(running))
        {
            let item = &mut items[idx];
            let control = TransferControl::new();
            item.control = Some(control.clone());
            item.info.state = TransferState::Running;
            item.info.error = None;
            to_start.push((item.info.clone(), control, item.partial));
        }
    }
    for (info, control, partial) in to_start {
        emit(app, &info);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            run_transfer(app, info, control, partial).await;
        });
    }
}

async fn run_transfer(
    app: AppHandle,
    info: TransferInfo,
    control: Arc<TransferControl>,
    mut partial: Option<SourceStamp>,
) {
    let state = app.state::<AppState>();
    let manager = state.transfers.clone();
    let id = info.id.clone();

    let result = match state.sftp_entry(&info.sftp_id) {
        Err(e) => Err(SshError::Other(e.message)),
        Ok(entry) => {
            let app2 = app.clone();
            let manager2 = manager.clone();
            let id2 = id.clone();
            let mut last_emit = Instant::now();
            let started = Instant::now();
            let mut start_bytes: Option<u64> = None;
            let progress = move |done: u64, total: u64| {
                let base = *start_bytes.get_or_insert(done);
                let now = Instant::now();
                if now.duration_since(last_emit).as_millis() < 200 && done < total {
                    return;
                }
                last_emit = now;
                let elapsed = started.elapsed().as_secs_f64().max(0.001);
                let speed = ((done - base) as f64 / elapsed) as u64;
                manager2.update(&app2, &id2, |i| {
                    i.info.transferred = done;
                    i.info.size = total;
                    i.info.speed = speed;
                });
            };
            let local = PathBuf::from(&info.local_path);
            match info.direction {
                Direction::Download => {
                    entry
                        .client
                        .download(&info.remote_path, &local, &mut partial, &control, progress)
                        .await
                }
                Direction::Upload => {
                    entry
                        .client
                        .upload(&local, &info.remote_path, &mut partial, &control, progress)
                        .await
                }
            }
        }
    };

    manager.update(&app, &id, |i| {
        i.control = None;
        i.partial = partial;
        i.info.speed = 0;
        match result {
            Ok(n) => {
                i.info.state = TransferState::Done;
                i.info.transferred = n;
                i.info.size = i.info.size.max(n);
            }
            // Paused or cancelled by the user: state already set.
            Err(SshError::Cancelled) => {}
            Err(e) => {
                if i.info.state == TransferState::Running {
                    i.info.state = TransferState::Error;
                    i.info.error = Some(e.to_string());
                }
            }
        }
    });
    if result_is_download_done(&manager, &id) {
        let _ = app.emit("sftp-download-done", &id);
    }
    pump(&app);
}

fn result_is_download_done(manager: &TransferManager, id: &str) -> bool {
    manager.items.lock().unwrap().iter().any(|i| {
        i.info.id == id
            && i.info.state == TransferState::Done
            && i.info.direction == Direction::Download
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, priority: i32) -> Item {
        Item {
            info: TransferInfo {
                id: id.into(),
                sftp_id: "s".into(),
                direction: Direction::Download,
                local_path: "l".into(),
                remote_path: "r".into(),
                name: id.into(),
                size: 0,
                transferred: 0,
                state: TransferState::Queued,
                error: None,
                priority,
                created_at: 0,
                speed: 0,
            },
            control: None,
            partial: None,
        }
    }

    #[test]
    fn resumed_item_waits_for_previous_attempt_to_stop() {
        let mut items = vec![item("a", 0), item("b", 1)];
        assert_eq!(startable(&items), [1, 0]);
        // Paused and resumed while the old task is still running.
        items[1].control = Some(TransferControl::new());
        assert_eq!(startable(&items), [0]);
        items[1].control = None;
        assert_eq!(startable(&items), [1, 0]);
    }
}
