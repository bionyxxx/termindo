//! Registration, login, token refresh, logout and account recovery.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};
use termindo_core::crypto::KdfParams;
use termindo_core::{new_id, now_ms};
use termindo_sync::protocol::*;

use crate::error::{AppError, AppResult};
use crate::security::{self, AuthUser};
use crate::AppState;

#[derive(Debug, sqlx::FromRow)]
pub struct UserRow {
    pub id: String,
    pub email: String,
    pub auth_hash: String,
    pub kdf_salt: String,
    pub kdf_m: i32,
    pub kdf_t: i32,
    pub kdf_p: i32,
    pub wrapped_dek: String,
    pub wrapped_dek_recovery: Option<String>,
    pub recovery_auth_hash: Option<String>,
}

impl UserRow {
    pub fn kdf(&self) -> KdfParams {
        KdfParams {
            m_cost: self.kdf_m as u32,
            t_cost: self.kdf_t as u32,
            p_cost: self.kdf_p as u32,
        }
    }

    pub fn keys(&self) -> AccountKeys {
        AccountKeys {
            kdf_salt: self.kdf_salt.clone(),
            kdf: self.kdf(),
            wrapped_dek: self.wrapped_dek.clone(),
            wrapped_dek_recovery: self.wrapped_dek_recovery.clone(),
        }
    }
}

const USER_COLUMNS: &str =
    "id, email, auth_hash, kdf_salt, kdf_m, kdf_t, kdf_p, wrapped_dek, wrapped_dek_recovery, recovery_auth_hash";

pub async fn user_by_email(db: &sqlx::PgPool, email: &str) -> AppResult<Option<UserRow>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {USER_COLUMNS} FROM users WHERE email = $1"
    ))
    .bind(email)
    .fetch_optional(db)
    .await?)
}

pub async fn user_by_id(db: &sqlx::PgPool, id: &str) -> AppResult<UserRow> {
    sqlx::query_as(&format!("SELECT {USER_COLUMNS} FROM users WHERE id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(AppError::unauthorized)
}

/// Validate client-supplied key material.
pub fn validate_keys(
    kdf_salt: &str,
    kdf: &KdfParams,
    wrapped_dek: &str,
    wrapped_dek_recovery: Option<&str>,
) -> AppResult<()> {
    security::check_b64("kdf_salt", kdf_salt, 16, 64)?;
    kdf.validate()
        .map_err(|e| AppError::bad_request(e.to_string()))?;
    if kdf.m_cost > i32::MAX as u32 || kdf.t_cost > 64 || kdf.p_cost > 64 {
        return Err(AppError::bad_request("unsupported KDF parameters"));
    }
    // nonce (24) + key (32) + tag (16) = 72 bytes; allow some room for future formats.
    security::check_b64("wrapped_dek", wrapped_dek, 40, 1024)?;
    if let Some(r) = wrapped_dek_recovery {
        security::check_b64("wrapped_dek_recovery", r, 40, 1024)?;
    }
    Ok(())
}

fn check_auth_hash(field: &str, value: &str) -> AppResult<()> {
    security::check_b64(field, value, 32, 64)
}

/// Create a device + refresh token and build the auth response.
pub async fn create_session(
    state: &AppState,
    user: &UserRow,
    device_name: &str,
) -> AppResult<AuthResponse> {
    let now = now_ms();
    let device_id = new_id();
    let (refresh_token, refresh_hash) = security::new_refresh_token();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO devices (id, user_id, name, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $4)")
        .bind(&device_id)
        .bind(&user.id)
        .bind(security::normalize_device_name(device_name))
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO refresh_tokens (token_hash, device_id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&refresh_hash)
    .bind(&device_id)
    .bind(&user.id)
    .bind(now)
    .bind(now + security::REFRESH_TTL_MS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(AuthResponse {
        access_token: security::issue_access_token(&state.config.jwt_secret, &user.id, &device_id)?,
        refresh_token,
        expires_in: security::ACCESS_TTL_SECS,
        user_id: user.id.clone(),
        device_id,
        email: user.email.clone(),
        keys: user.keys(),
    })
}

/// Revoke every device of `user_id` except `keep` (and their refresh tokens).
pub async fn revoke_other_devices(
    db: &sqlx::PgPool,
    user_id: &str,
    keep: Option<&str>,
) -> AppResult<()> {
    let now = now_ms();
    sqlx::query("UPDATE devices SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL AND ($3::TEXT IS NULL OR id <> $3)")
        .bind(now)
        .bind(user_id)
        .bind(keep)
        .execute(db)
        .await?;
    sqlx::query(
        "DELETE FROM refresh_tokens WHERE user_id = $1 AND ($2::TEXT IS NULL OR device_id <> $2)",
    )
    .bind(user_id)
    .bind(keep)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn prelogin(
    State(state): State<AppState>,
    Json(req): Json<PreloginRequest>,
) -> AppResult<Json<PreloginResponse>> {
    let email = security::normalize_email(&req.email)?;
    let resp = match user_by_email(&state.db, &email).await? {
        Some(u) => PreloginResponse {
            kdf_salt: u.kdf_salt.clone(),
            kdf: u.kdf(),
        },
        None => PreloginResponse {
            kdf_salt: security::fake_salt(&state.config.jwt_secret, &email),
            kdf: KdfParams::default(),
        },
    };
    Ok(Json(resp))
}

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> AppResult<Json<AuthResponse>> {
    if !state.config.allow_registration {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "registration_disabled",
            "registration is disabled on this server",
        ));
    }
    let email = security::normalize_email(&req.email)?;
    check_auth_hash("auth_hash", &req.auth_hash)?;
    if let Some(r) = &req.recovery_auth_hash {
        check_auth_hash("recovery_auth_hash", r)?;
    }
    validate_keys(
        &req.keys.kdf_salt,
        &req.keys.kdf,
        &req.keys.wrapped_dek,
        req.keys.wrapped_dek_recovery.as_deref(),
    )?;

    let auth_hash = security::hash_secret(req.auth_hash.clone()).await?;
    let recovery_hash = match &req.recovery_auth_hash {
        Some(r) => Some(security::hash_secret(r.clone()).await?),
        None => None,
    };

    let now = now_ms();
    let user = UserRow {
        id: new_id(),
        email,
        auth_hash,
        kdf_salt: req.keys.kdf_salt.clone(),
        kdf_m: req.keys.kdf.m_cost as i32,
        kdf_t: req.keys.kdf.t_cost as i32,
        kdf_p: req.keys.kdf.p_cost as i32,
        wrapped_dek: req.keys.wrapped_dek.clone(),
        wrapped_dek_recovery: req.keys.wrapped_dek_recovery.clone(),
        recovery_auth_hash: recovery_hash,
    };
    let inserted = sqlx::query(&format!(
        "INSERT INTO users ({USER_COLUMNS}, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         ON CONFLICT (email) DO NOTHING"
    ))
    .bind(&user.id)
    .bind(&user.email)
    .bind(&user.auth_hash)
    .bind(&user.kdf_salt)
    .bind(user.kdf_m)
    .bind(user.kdf_t)
    .bind(user.kdf_p)
    .bind(&user.wrapped_dek)
    .bind(&user.wrapped_dek_recovery)
    .bind(&user.recovery_auth_hash)
    .bind(now)
    .execute(&state.db)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "email_taken",
            "an account with this email already exists",
        ));
    }
    tracing::info!(user_id = %user.id, "account registered");
    Ok(Json(create_session(&state, &user, &req.device_name).await?))
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> AppResult<Json<AuthResponse>> {
    let email = security::normalize_email(&req.email)?;
    let user = user_by_email(&state.db, &email).await?;
    let ok = security::verify_secret(
        req.auth_hash.clone(),
        user.as_ref().map(|u| u.auth_hash.clone()),
    )
    .await?;
    match user {
        Some(user) if ok => Ok(Json(create_session(&state, &user, &req.device_name).await?)),
        _ => Err(AppError::invalid_credentials()),
    }
}

/// (device_id, user_id, expires_at, used_at, device revoked_at)
type RefreshRow = (String, String, i64, Option<i64>, Option<i64>);

pub async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> AppResult<Json<TokenResponse>> {
    let hash = security::hash_refresh_token(req.refresh_token.trim());
    let now = now_ms();
    let mut tx = state.db.begin().await?;
    let row: Option<RefreshRow> = sqlx::query_as(
        "SELECT t.device_id, t.user_id, t.expires_at, t.used_at, d.revoked_at
         FROM refresh_tokens t JOIN devices d ON d.id = t.device_id
         WHERE t.token_hash = $1 FOR UPDATE OF t",
    )
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((device_id, user_id, expires_at, used_at, revoked_at)) = row else {
        return Err(AppError::unauthorized());
    };
    if used_at.is_some() {
        // A rotated token was presented again: assume it was stolen and sign the device out.
        sqlx::query("UPDATE devices SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL")
            .bind(now)
            .bind(&device_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM refresh_tokens WHERE device_id = $1")
            .bind(&device_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        tracing::warn!(device_id = %device_id, "refresh token reuse detected; device revoked");
        return Err(AppError::unauthorized());
    }
    if revoked_at.is_some() || expires_at < now {
        return Err(AppError::unauthorized());
    }

    let (new_token, new_hash) = security::new_refresh_token();
    sqlx::query("UPDATE refresh_tokens SET used_at = $1 WHERE token_hash = $2")
        .bind(now)
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO refresh_tokens (token_hash, device_id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&new_hash)
    .bind(&device_id)
    .bind(&user_id)
    .bind(now)
    .bind(now + security::REFRESH_TTL_MS)
    .execute(&mut *tx)
    .await?;
    // Keep only the newest used token per device for reuse detection; drop older ones.
    sqlx::query("DELETE FROM refresh_tokens WHERE device_id = $1 AND used_at IS NOT NULL AND token_hash <> $2")
        .bind(&device_id)
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE devices SET last_seen_at = $1 WHERE id = $2")
        .bind(now)
        .bind(&device_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(TokenResponse {
        access_token: security::issue_access_token(&state.config.jwt_secret, &user_id, &device_id)?,
        refresh_token: new_token,
        expires_in: security::ACCESS_TTL_SECS,
    }))
}

pub async fn logout(State(state): State<AppState>, auth: AuthUser) -> AppResult<Json<Value>> {
    sqlx::query("UPDATE devices SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL")
        .bind(now_ms())
        .bind(&auth.device_id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM refresh_tokens WHERE device_id = $1")
        .bind(&auth.device_id)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

/// Look up a user and verify their recovery auth key. Uniform failure for unknown emails.
async fn verify_recovery(
    state: &AppState,
    email: &str,
    recovery_auth_hash: &str,
) -> AppResult<UserRow> {
    check_auth_hash("recovery_auth_hash", recovery_auth_hash)?;
    let email = security::normalize_email(email)?;
    let user = user_by_email(&state.db, &email).await?;
    let stored = user.as_ref().and_then(|u| u.recovery_auth_hash.clone());
    let ok = security::verify_secret(recovery_auth_hash.to_string(), stored).await?;
    match user {
        Some(u) if ok && u.wrapped_dek_recovery.is_some() => Ok(u),
        _ => Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_recovery_key",
            "invalid email or recovery key",
        )),
    }
}

pub async fn recover_challenge(
    State(state): State<AppState>,
    Json(req): Json<RecoverChallengeRequest>,
) -> AppResult<Json<RecoverChallengeResponse>> {
    let user = verify_recovery(&state, &req.email, &req.recovery_auth_hash).await?;
    Ok(Json(RecoverChallengeResponse {
        wrapped_dek_recovery: user.wrapped_dek_recovery.unwrap_or_default(),
    }))
}

pub async fn recover(
    State(state): State<AppState>,
    Json(req): Json<RecoverRequest>,
) -> AppResult<Json<AuthResponse>> {
    let user = verify_recovery(&state, &req.email, &req.recovery_auth_hash).await?;
    check_auth_hash("new_auth_hash", &req.new_auth_hash)?;
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
    .bind(&user.id)
    .execute(&state.db)
    .await?;
    revoke_other_devices(&state.db, &user.id, None).await?;
    tracing::info!(user_id = %user.id, "account recovered with recovery key");

    let user = user_by_id(&state.db, &user.id).await?;
    Ok(Json(create_session(&state, &user, &req.device_name).await?))
}
