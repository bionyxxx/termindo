//! Password-equivalent hashing, tokens and the authenticated-request extractor.

use std::sync::OnceLock;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use hmac::{Hmac, Mac};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use termindo_core::{crypto, now_ms};

use crate::error::{AppError, AppResult};
use crate::AppState;

/// Access token lifetime.
pub const ACCESS_TTL_SECS: i64 = 15 * 60;
/// Refresh token lifetime.
pub const REFRESH_TTL_MS: i64 = 60 * 24 * 60 * 60 * 1000;
/// `last_seen_at` is refreshed at most this often.
const LAST_SEEN_RESOLUTION_MS: i64 = 60 * 1000;

// -- Argon2id hashing of client auth keys --------------------------------------

fn argon2() -> Argon2<'static> {
    // Argon2id v19 with the crate defaults (19 MiB, 2 passes, 1 lane): the input is
    // already a 256-bit key derived with a slow KDF client-side, so this mainly
    // protects against reuse of a leaked database.
    Argon2::default()
}

/// Hash a client-supplied secret (auth key / recovery auth key) into a PHC string.
pub async fn hash_secret(secret: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || {
        let mut salt = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let salt = SaltString::encode_b64(&salt).map_err(|_| AppError::internal())?;
        argon2()
            .hash_password(secret.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| {
                tracing::error!("argon2 hashing failed: {e}");
                AppError::internal()
            })
    })
    .await?
}

/// Verify a secret against a stored PHC string. With `None` a dummy hash is
/// verified so unknown accounts take the same time as wrong passwords.
pub async fn verify_secret(secret: String, phc: Option<String>) -> AppResult<bool> {
    Ok(tokio::task::spawn_blocking(move || {
        let phc = phc.unwrap_or_else(|| dummy_hash().to_string());
        match PasswordHash::new(&phc) {
            Ok(parsed) => argon2().verify_password(secret.as_bytes(), &parsed).is_ok(),
            Err(_) => false,
        }
    })
    .await?)
}

fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| {
        let salt = SaltString::encode_b64(&[7u8; 16]).expect("valid salt");
        argon2()
            .hash_password(b"termindo-dummy", &salt)
            .expect("hash")
            .to_string()
    })
}

/// Validate that a base64 field decodes to a sensible length.
pub fn check_b64(field: &str, value: &str, min: usize, max: usize) -> AppResult<()> {
    match crypto::unb64(value) {
        Ok(bytes) if bytes.len() >= min && bytes.len() <= max => Ok(()),
        _ => Err(AppError::bad_request(format!(
            "{field} must be base64 encoding {min}..={max} bytes"
        ))),
    }
}

pub fn normalize_email(email: &str) -> AppResult<String> {
    let e = email.trim().to_lowercase();
    let valid = e.len() <= 254
        && e.split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && !domain.is_empty())
        && !e.chars().any(char::is_whitespace);
    if !valid {
        return Err(AppError::bad_request("invalid email address"));
    }
    Ok(e)
}

pub fn normalize_device_name(name: &str) -> String {
    let n: String = name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect();
    if n.is_empty() {
        "Unknown device".into()
    } else {
        n
    }
}

/// Deterministic per-email salt for unknown accounts, so `prelogin` cannot be
/// used to discover which emails are registered.
pub fn fake_salt(secret: &[u8], email: &str) -> String {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(b"termindo/fake-salt/v1:");
    mac.update(email.as_bytes());
    let out = mac.finalize().into_bytes();
    crypto::b64(&out[..16])
}

// -- tokens ------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub did: String,
    pub iat: i64,
    pub exp: i64,
}

pub fn issue_access_token(secret: &[u8], user_id: &str, device_id: &str) -> AppResult<String> {
    let now = now_ms() / 1000;
    let claims = Claims {
        sub: user_id.into(),
        did: device_id.into(),
        iat: now,
        exp: now + ACCESS_TTL_SECS,
    };
    jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret),
    )
    .map_err(|e| {
        tracing::error!("jwt encoding failed: {e}");
        AppError::internal()
    })
}

pub fn verify_access_token(secret: &[u8], token: &str) -> AppResult<Claims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 30;
    jsonwebtoken::decode::<Claims>(token, &DecodingKey::from_secret(secret), &validation)
        .map(|d| d.claims)
        .map_err(|_| AppError::unauthorized())
}

/// New random refresh token and its storage hash.
pub fn new_refresh_token() -> (String, String) {
    let mut raw = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let token = hex(&raw);
    let hash = hash_refresh_token(&token);
    (token, hash)
}

pub fn hash_refresh_token(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// -- extractor ------------------------------------------------------------------

/// An authenticated request: valid access token for a non-revoked device.
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: String,
    pub device_id: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(AppError::unauthorized)?;
        let token = header
            .strip_prefix("Bearer ")
            .or_else(|| header.strip_prefix("bearer "))
            .ok_or_else(AppError::unauthorized)?;
        let claims = verify_access_token(&state.config.jwt_secret, token.trim())?;

        let row: Option<(Option<i64>, i64)> = sqlx::query_as(
            "SELECT revoked_at, last_seen_at FROM devices WHERE id = $1 AND user_id = $2",
        )
        .bind(&claims.did)
        .bind(&claims.sub)
        .fetch_optional(&state.db)
        .await?;
        let Some((revoked_at, last_seen_at)) = row else {
            return Err(AppError::unauthorized());
        };
        if revoked_at.is_some() {
            return Err(AppError::new(
                axum::http::StatusCode::UNAUTHORIZED,
                "device_revoked",
                "this device has been signed out",
            ));
        }
        let now = now_ms();
        if now - last_seen_at > LAST_SEEN_RESOLUTION_MS {
            sqlx::query("UPDATE devices SET last_seen_at = $1 WHERE id = $2")
                .bind(now)
                .bind(&claims.did)
                .execute(&state.db)
                .await?;
        }
        Ok(AuthUser {
            user_id: claims.sub,
            device_id: claims.did,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jwt_roundtrip() {
        let secret = b"0123456789abcdef0123456789abcdef";
        let t = issue_access_token(secret, "u1", "d1").unwrap();
        let c = verify_access_token(secret, &t).unwrap();
        assert_eq!(c.sub, "u1");
        assert_eq!(c.did, "d1");
        assert!(verify_access_token(b"another-secret-another-secret-xx", &t).is_err());
    }

    #[test]
    fn fake_salt_is_deterministic() {
        let a = fake_salt(b"secret", "a@b.c");
        assert_eq!(a, fake_salt(b"secret", "a@b.c"));
        assert_ne!(a, fake_salt(b"secret", "x@b.c"));
        assert_eq!(crypto::unb64(&a).unwrap().len(), 16);
    }

    #[test]
    fn emails() {
        assert_eq!(
            normalize_email("  Foo@Example.COM ").unwrap(),
            "foo@example.com"
        );
        assert!(normalize_email("nope").is_err());
        assert!(normalize_email("@x").is_err());
    }

    #[tokio::test]
    async fn hashing() {
        let h = hash_secret("key".into()).await.unwrap();
        assert!(verify_secret("key".into(), Some(h.clone())).await.unwrap());
        assert!(!verify_secret("nope".into(), Some(h)).await.unwrap());
        assert!(!verify_secret("key".into(), None).await.unwrap());
    }
}
