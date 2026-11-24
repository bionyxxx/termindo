//! Sync engine: push local changes, pull remote changes, merge with last-write-wins.
//!
//! The database lock is only held for short synchronous sections, never across
//! network calls, so the UI stays responsive while syncing.

use std::sync::Mutex;

use serde::Serialize;
use termindo_core::crypto::KEY_LEN;
use termindo_core::db::Db;
use termindo_core::models::*;

use crate::client::{ClientError, SyncClient};
use crate::envelope::{decode_entity, open_payload, seal_entity, RecordPayload};
use crate::protocol::{PushRecord, MAX_PUSH};

pub const CURSOR_KEY: &str = "cursor";
pub const LAST_SYNC_KEY: &str = "last_synced_at";
const PULL_PAGE: u32 = 500;

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error(transparent)]
    Core(#[from] termindo_core::Error),
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub pushed: usize,
    pub rejected: usize,
    pub pulled: usize,
    pub applied: usize,
    /// Records that could not be decrypted or decoded (skipped).
    pub skipped: usize,
    pub finished_at: i64,
}

struct Outgoing {
    kind: &'static str,
    record: PushRecord,
}

fn collect<T: Entity>(
    db: &Db,
    dek: &[u8; KEY_LEN],
    out: &mut Vec<Outgoing>,
) -> termindo_core::Result<()> {
    for item in db.dirty::<T>()? {
        out.push(Outgoing {
            kind: T::KIND,
            record: PushRecord {
                id: item.id().to_string(),
                updated_at: item.updated_at(),
                deleted: item.deleted_at().is_some(),
                blob: seal_entity(dek, &item)?,
            },
        });
    }
    Ok(())
}

fn collect_dirty(db: &Db, dek: &[u8; KEY_LEN]) -> termindo_core::Result<Vec<Outgoing>> {
    let mut out = Vec::new();
    collect::<Group>(db, dek, &mut out)?;
    collect::<Credential>(db, dek, &mut out)?;
    collect::<Host>(db, dek, &mut out)?;
    collect::<Snippet>(db, dek, &mut out)?;
    collect::<KnownHost>(db, dek, &mut out)?;
    Ok(out)
}

fn mark_clean(db: &Db, kind: &str, id: &str, updated_at: i64) -> termindo_core::Result<()> {
    match kind {
        Group::KIND => db.mark_clean::<Group>(id, updated_at),
        Credential::KIND => db.mark_clean::<Credential>(id, updated_at),
        Host::KIND => db.mark_clean::<Host>(id, updated_at),
        Snippet::KIND => db.mark_clean::<Snippet>(id, updated_at),
        KnownHost::KIND => db.mark_clean::<KnownHost>(id, updated_at),
        _ => Ok(()),
    }
}

/// Apply one decrypted payload. Returns `true` if the local database changed.
pub fn apply_payload(db: &Db, id: &str, payload: RecordPayload) -> termindo_core::Result<bool> {
    match payload.kind.as_str() {
        Group::KIND => db.apply_remote(&decode_entity::<Group>(id, payload)?),
        Credential::KIND => db.apply_remote(&decode_entity::<Credential>(id, payload)?),
        Host::KIND => db.apply_remote(&decode_entity::<Host>(id, payload)?),
        Snippet::KIND => db.apply_remote(&decode_entity::<Snippet>(id, payload)?),
        KnownHost::KIND => db.apply_remote(&decode_entity::<KnownHost>(id, payload)?),
        other => {
            tracing::warn!(
                kind = other,
                "ignoring record of unknown kind (newer client?)"
            );
            Ok(false)
        }
    }
}

/// Run one full sync cycle.
pub async fn sync(
    client: &SyncClient,
    db: &Mutex<Db>,
    dek: &[u8; KEY_LEN],
) -> Result<SyncReport, SyncError> {
    let mut report = SyncReport::default();

    // 1. Push.
    let outgoing = collect_dirty(&db.lock().unwrap(), dek)?;
    for batch in outgoing.chunks(MAX_PUSH) {
        let resp = client
            .push(batch.iter().map(|o| o.record.clone()).collect())
            .await?;
        let guard = db.lock().unwrap();
        for o in batch {
            if resp.accepted.iter().any(|id| id == &o.record.id) {
                mark_clean(&guard, o.kind, &o.record.id, o.record.updated_at)?;
                report.pushed += 1;
            }
        }
        report.rejected += resp.rejected.len();
    }

    // 2. Pull.
    let mut cursor: i64 = db
        .lock()
        .unwrap()
        .sync_value(CURSOR_KEY)?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    loop {
        let page = client.pull(cursor, PULL_PAGE).await?;
        {
            let guard = db.lock().unwrap();
            let tx = guard
                .conn()
                .unchecked_transaction()
                .map_err(termindo_core::Error::from)?;
            for rec in &page.records {
                report.pulled += 1;
                match open_payload(dek, &rec.id, &rec.blob)
                    .and_then(|p| apply_payload(&guard, &rec.id, p))
                {
                    Ok(true) => report.applied += 1,
                    Ok(false) => {}
                    Err(e) => {
                        report.skipped += 1;
                        tracing::warn!(id = %rec.id, "skipping undecodable record: {e}");
                    }
                }
            }
            cursor = cursor.max(page.cursor);
            guard.set_sync_value(CURSOR_KEY, Some(&cursor.to_string()))?;
            tx.commit().map_err(termindo_core::Error::from)?;
        }
        if !page.has_more || page.records.is_empty() {
            break;
        }
    }

    report.finished_at = termindo_core::now_ms();
    db.lock()
        .unwrap()
        .set_sync_value(LAST_SYNC_KEY, Some(&report.finished_at.to_string()))?;
    Ok(report)
}

/// Forget sync state (after logout) so a future login starts from scratch.
pub fn reset_state(db: &Db) -> termindo_core::Result<()> {
    db.set_sync_value(CURSOR_KEY, None)?;
    db.set_sync_value(LAST_SYNC_KEY, None)?;
    Ok(())
}
