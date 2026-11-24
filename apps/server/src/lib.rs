//! Termindo sync server.
//!
//! Stores opaque, client-encrypted records and the minimum metadata needed for
//! sync (id, client `updated_at`, tombstone flag, server `seq`). It never sees
//! the master password, the master key, the DEK or any plaintext record.

pub mod account;
pub mod auth;
pub mod config;
pub mod error;
pub mod ratelimit;
pub mod security;
pub mod sync;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, post};
use axum::{middleware, Json, Router};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use termindo_sync::protocol::API_PREFIX;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

pub use config::Config;

/// Maximum request body (large pushes).
pub const BODY_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub limiter: Arc<ratelimit::RateLimiter>,
}

impl AppState {
    pub fn new(db: PgPool, config: Config) -> Self {
        Self {
            db,
            config: Arc::new(config),
            limiter: Arc::new(ratelimit::RateLimiter::new(30, 60)),
        }
    }
}

/// Connect to Postgres and apply embedded migrations.
pub async fn connect_db(url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(16)
        .connect(url)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub fn router(state: AppState) -> Router {
    let auth_routes = Router::new()
        .route("/auth/prelogin", post(auth::prelogin))
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        .route("/auth/refresh", post(auth::refresh))
        .route("/auth/recover/challenge", post(auth::recover_challenge))
        .route("/auth/recover", post(auth::recover))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            ratelimit::limit_auth,
        ));

    let api = Router::new()
        .merge(auth_routes)
        .route("/auth/logout", post(auth::logout))
        .route("/account/keys", get(account::keys))
        .route("/account/password", post(account::change_password))
        .route("/devices", get(account::list_devices))
        .route("/devices/{id}", delete(account::revoke_device))
        .route("/sync", get(sync::pull).post(sync::push));

    Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({ "status": "ok" })) }),
        )
        .nest(API_PREFIX, api)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Serve until `shutdown` resolves.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
}
