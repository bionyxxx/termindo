//! Bridges SSH connection callbacks (host key checks, keyboard-interactive) to the UI.
//!
//! The backend emits a `prompt` event `{ id, kind, ... }` and waits until the UI
//! calls the `prompt_respond` command with the same id.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use termindo_core::models::KnownHost;
use termindo_ssh::client::BoxFuture;
use termindo_ssh::{HostKeyInfo, Interaction, KbdRequest};

use crate::state::AppState;

const PROMPT_TIMEOUT: Duration = Duration::from_secs(600);

/// Show a prompt in the UI and wait for the answer. `None` if dismissed / timed out.
pub async fn ask(app: &AppHandle, kind: &str, mut payload: Value) -> Option<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.state::<AppState>()
        .prompts
        .lock()
        .unwrap()
        .insert(id.clone(), tx);
    if let Value::Object(map) = &mut payload {
        map.insert("id".into(), json!(id));
        map.insert("kind".into(), json!(kind));
    }
    if app.emit("prompt", payload).is_err() {
        app.state::<AppState>().prompts.lock().unwrap().remove(&id);
        return None;
    }
    let res = tokio::time::timeout(PROMPT_TIMEOUT, rx).await;
    app.state::<AppState>().prompts.lock().unwrap().remove(&id);
    match res {
        Ok(Ok(v)) if !v.is_null() => Some(v),
        _ => None,
    }
}

pub struct DesktopInteraction {
    pub app: AppHandle,
    /// Label shown in prompts (host label).
    pub label: String,
}

impl Interaction for DesktopInteraction {
    fn verify_host_key(&self, info: HostKeyInfo) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            let state = self.app.state::<AppState>();
            let existing = match state.db().known_host(&info.host, info.port) {
                Ok(k) => k,
                Err(e) => {
                    tracing::error!("known_hosts lookup failed: {e}");
                    return false;
                }
            };
            if let Some(k) = &existing {
                if k.key == info.key && k.key_type == info.key_type {
                    return true;
                }
            }
            let status = if existing.is_some() {
                "changed"
            } else {
                "unknown"
            };
            let answer = ask(
                &self.app,
                "hostKey",
                json!({
                    "label": self.label,
                    "status": status,
                    "info": info,
                    "previousFingerprint": existing.as_ref().map(|k| k.fingerprint.clone()),
                    "previousKeyType": existing.as_ref().map(|k| k.key_type.clone()),
                }),
            )
            .await;
            let accept = answer
                .as_ref()
                .and_then(|v| v.get("accept"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !accept {
                return false;
            }
            let mut kh = KnownHost {
                id: KnownHost::make_id(&info.host, info.port),
                host: info.host.to_ascii_lowercase(),
                port: info.port,
                key_type: info.key_type.clone(),
                key: info.key.clone(),
                fingerprint: info.fingerprint.clone(),
                updated_at: 0,
                deleted_at: None,
            };
            if let Err(e) = state.db().save(&mut kh) {
                tracing::error!("saving known host failed: {e}");
            }
            state.sync.schedule();
            true
        })
    }

    fn keyboard_interactive(&self, req: KbdRequest) -> BoxFuture<'_, Option<Vec<String>>> {
        Box::pin(async move {
            let answer = ask(
                &self.app,
                "keyboardInteractive",
                json!({ "label": self.label, "request": req }),
            )
            .await?;
            let answers = answer.get("answers")?.as_array()?;
            Some(
                answers
                    .iter()
                    .map(|a| a.as_str().unwrap_or_default().to_string())
                    .collect(),
            )
        })
    }

    fn banner(&self, host: &str, banner: &str) {
        let _ = self
            .app
            .emit("ssh-banner", json!({ "host": host, "banner": banner }));
    }
}
