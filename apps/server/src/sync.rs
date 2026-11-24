//! Record pull/push.
//!
//! Ordering guarantee: pushes for one account are serialised with a
//! transaction-scoped advisory lock, so `seq` values become visible in
//! increasing order per account and a pull cursor can never skip a record.

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use termindo_sync::protocol::*;

use crate::error::{AppError, AppResult};
use crate::security::AuthUser;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct PullQuery {
    #[serde(default)]
    pub since: i64,
    pub limit: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct RecordRow {
    id: String,
    seq: i64,
    updated_at: i64,
    deleted: bool,
    blob: String,
}

pub async fn pull(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(q): Query<PullQuery>,
) -> AppResult<Json<PullResponse>> {
    let limit = q.limit.unwrap_or(500).clamp(1, 1000);
    // Fetch one extra row to know whether more pages exist.
    let mut rows: Vec<RecordRow> = sqlx::query_as(
        "SELECT id, seq, updated_at, deleted, blob FROM records
         WHERE user_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3",
    )
    .bind(&auth.user_id)
    .bind(q.since)
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let cursor = rows.last().map(|r| r.seq).unwrap_or(q.since);
    Ok(Json(PullResponse {
        records: rows
            .into_iter()
            .map(|r| RemoteRecord {
                id: r.id,
                seq: r.seq,
                updated_at: r.updated_at,
                deleted: r.deleted,
                blob: r.blob,
            })
            .collect(),
        cursor,
        has_more,
    }))
}

fn validate(rec: &PushRecord) -> AppResult<()> {
    if rec.id.is_empty() || rec.id.len() > 200 {
        return Err(AppError::bad_request(
            "record id must be 1..=200 characters",
        ));
    }
    if rec.blob.is_empty() || rec.blob.len() > MAX_BLOB_LEN {
        return Err(AppError::bad_request(format!(
            "record blob must be 1..={MAX_BLOB_LEN} characters"
        )));
    }
    if rec.updated_at <= 0 {
        return Err(AppError::bad_request("record updated_at must be positive"));
    }
    Ok(())
}

pub async fn push(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<PushRequest>,
) -> AppResult<Json<PushResponse>> {
    if req.records.len() > MAX_PUSH {
        return Err(AppError::bad_request(format!(
            "at most {MAX_PUSH} records per push"
        )));
    }
    for r in &req.records {
        validate(r)?;
    }

    let mut accepted = Vec::new();
    let mut rejected = Vec::new();
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&auth.user_id)
        .execute(&mut *tx)
        .await?;

    for rec in req.records {
        let existing: Option<(i64,)> =
            sqlx::query_as("SELECT updated_at FROM records WHERE user_id = $1 AND id = $2")
                .bind(&auth.user_id)
                .bind(&rec.id)
                .fetch_optional(&mut *tx)
                .await?;
        match decide_push(rec.updated_at, existing.map(|e| e.0)) {
            PushDecision::Store => {
                sqlx::query(
                    "INSERT INTO records (user_id, id, seq, updated_at, deleted, blob, device_id)
                     VALUES ($1, $2, nextval('record_seq'), $3, $4, $5, $6)
                     ON CONFLICT (user_id, id) DO UPDATE SET
                        seq = EXCLUDED.seq, updated_at = EXCLUDED.updated_at, deleted = EXCLUDED.deleted,
                        blob = EXCLUDED.blob, device_id = EXCLUDED.device_id",
                )
                .bind(&auth.user_id)
                .bind(&rec.id)
                .bind(rec.updated_at)
                .bind(rec.deleted)
                .bind(&rec.blob)
                .bind(&auth.device_id)
                .execute(&mut *tx)
                .await?;
                accepted.push(rec.id);
            }
            PushDecision::AlreadyStored => accepted.push(rec.id),
            PushDecision::Reject => rejected.push(rec.id),
        }
    }
    tx.commit().await?;
    Ok(Json(PushResponse { accepted, rejected }))
}
