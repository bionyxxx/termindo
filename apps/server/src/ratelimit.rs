//! Fixed-window, per-IP rate limit for the unauthenticated `/auth/*` endpoints.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::AppError;
use crate::AppState;

pub struct RateLimiter {
    max: u32,
    window: Duration,
    hits: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new(max: u32, window_secs: u64) -> Self {
        Self {
            max,
            window: Duration::from_secs(window_secs),
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// Record a hit; returns `false` when the client is over the limit.
    pub fn check(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        if hits.len() > 10_000 {
            hits.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        let entry = hits.entry(ip).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.max
    }
}

fn client_ip(state: &AppState, req: &Request) -> Option<IpAddr> {
    if state.config.trust_proxy {
        let forwarded = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .and_then(|v| v.trim().parse().ok());
        if forwarded.is_some() {
            return forwarded;
        }
    }
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
}

pub async fn limit_auth(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if let Some(ip) = client_ip(&state, &req) {
        if !state.limiter.check(ip) {
            return AppError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "too many requests, try again later",
            )
            .into_response();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_per_ip() {
        let rl = RateLimiter::new(2, 60);
        let a: IpAddr = "10.0.0.1".parse().unwrap();
        let b: IpAddr = "10.0.0.2".parse().unwrap();
        assert!(rl.check(a));
        assert!(rl.check(a));
        assert!(!rl.check(a));
        assert!(rl.check(b));
    }
}
