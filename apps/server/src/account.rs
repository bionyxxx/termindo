//! Account keys, password change and device management.

use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};
use termindo_core::now_ms;
use termindo_sync::protocol::{AccountKeys, ChangePasswordRequest, Device};

use crate::auth::{revoke_other_devices, user_by_id, validate_keys};
use crate::error::{AppError, AppResult};
use crate::security::{self, AuthUser};
use crate::AppState;

pub async fn keys(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<AccountKeys>> {
    Ok(Json(user_by_id(&state.db, &auth.user_id).await?.keys()))
}

/// Replace the password-derived material. The DEK itself is unchanged (it is
/// only re-wrapped client-side), so no record needs re-encryption.
pub async fn change_password(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(req): Json<ChangePasswordRequest>,
) -> AppResult<Json<Value>> {
    let user = user_by_id(&state.db, &auth.user_id).await?;
    if !security::verify_secret(req.current_auth_hash.clone(), Some(user.auth_hash.clone())).await?
    {
        return Err(AppError::invalid_credentials());
    }
    security::check_b64("new_auth_hash", &req.new_auth_hash, 32, 64)?;
    validate_keys(&req.kdf_salt, &req.kdf, &req.wrapped_dek, None)?;
    let auth_hash = security::hash_secret(req.new_auth_hash.clone()).await?;

    sqlx::query(
        "UPDATE users SET auth_hash = $1, kdf_salt = $2, kdf_m = $3, kdf_t = $4, kdf_p = $5, wrapped_dek = $6, updated_at = $7
         WHERE id = $8",
    )
    .bind(&auth_hash)
    .bind(&req.kdf_salt)
    .bind(req.kdf.m_cost as i32)
    .bind(req.kdf.t_cost as i32)
    .bind(req.kdf.p_cost as i32)
    .bind(&req.wrapped_dek)
    .bind(now_ms())
    .bind(&auth.user_id)
    .execute(&state.db)
    .await?;
    revoke_other_devices(&state.db, &auth.user_id, Some(&auth.device_id)).await?;
    tracing::info!(user_id = %auth.user_id, "master password changed; other devices signed out");
    Ok(Json(json!({ "ok": true })))
}

pub async fn list_devices(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<Vec<Device>>> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT id, name, created_at, last_seen_at FROM devices
         WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC",
    )
    .bind(&auth.user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, name, created_at, last_seen_at)| Device {
                current: id == auth.device_id,
                id,
                name,
                created_at,
                last_seen_at,
            })
            .collect(),
    ))
}

pub async fn revoke_device(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let res = sqlx::query(
        "UPDATE devices SET revoked_at = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL",
    )
    .bind(now_ms())
    .bind(&id)
    .bind(&auth.user_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found("device not found"));
    }
    sqlx::query("DELETE FROM refresh_tokens WHERE device_id = $1")
        .bind(&id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}
