//! HTTP client for the sync server, with transparent access-token refresh.

use std::sync::Mutex;
use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::protocol::*;

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("cannot reach sync server: {0}")]
    Network(String),
    #[error("{message}")]
    Api {
        status: u16,
        code: String,
        message: String,
    },
    #[error("not signed in")]
    NotSignedIn,
    #[error("unexpected server response: {0}")]
    Decode(String),
}

impl ClientError {
    pub fn is_unauthorized(&self) -> bool {
        matches!(
            self,
            ClientError::Api { status: 401, .. } | ClientError::NotSignedIn
        )
    }
}

pub type ClientResult<T> = Result<T, ClientError>;

#[derive(Debug, Clone, Default)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
}

pub struct SyncClient {
    base: String,
    http: reqwest::Client,
    tokens: Mutex<Option<Tokens>>,
    /// Serialises token refreshes: refresh tokens rotate and the server revokes the
    /// device if an already-used one is presented, so two concurrent refreshes must
    /// never both hit the server.
    refresh_lock: tokio::sync::Mutex<()>,
}

impl SyncClient {
    pub fn new(base_url: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("termindo/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Self {
            base: base_url.trim_end_matches('/').to_string(),
            http,
            tokens: Mutex::new(None),
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub fn set_tokens(&self, tokens: Option<Tokens>) {
        *self.tokens.lock().unwrap() = tokens;
    }

    pub fn tokens(&self) -> Option<Tokens> {
        self.tokens.lock().unwrap().clone()
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}{}", self.base, API_PREFIX, path)
    }

    async fn send<B: Serialize, R: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        auth: bool,
    ) -> ClientResult<R> {
        let mut req = self.http.request(method, self.url(path));
        if auth {
            let token = self.tokens().ok_or(ClientError::NotSignedIn)?.access_token;
            req = req.bearer_auth(token);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ClientError::Network(e.to_string()))?;
        let status = resp.status();
        if status.is_success() {
            if status == StatusCode::NO_CONTENT {
                return serde_json::from_value(serde_json::Value::Null)
                    .map_err(|e| ClientError::Decode(e.to_string()));
            }
            return resp
                .json::<R>()
                .await
                .map_err(|e| ClientError::Decode(e.to_string()));
        }
        let text = resp.text().await.unwrap_or_default();
        let (code, message) = match serde_json::from_str::<ApiError>(&text) {
            Ok(e) => (e.code, e.error),
            Err(_) => ("http_error".to_string(), format!("HTTP {status}: {text}")),
        };
        Err(ClientError::Api {
            status: status.as_u16(),
            code,
            message,
        })
    }

    /// Authenticated request; on 401 refreshes the access token once and retries.
    async fn authed<B: Serialize, R: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> ClientResult<R> {
        let used_token = self.tokens().map(|t| t.access_token);
        match self.send(method.clone(), path, body, true).await {
            Err(e) if e.is_unauthorized() && used_token.is_some() => {
                self.refresh_if_stale(used_token.as_deref().unwrap_or_default())
                    .await?;
                self.send(method, path, body, true).await
            }
            other => other,
        }
    }

    pub async fn health(&self) -> ClientResult<()> {
        let resp = self
            .http
            .get(format!("{}/health", self.base))
            .send()
            .await
            .map_err(|e| ClientError::Network(e.to_string()))?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(ClientError::Network(format!("HTTP {}", resp.status())))
        }
    }

    pub async fn prelogin(&self, email: &str) -> ClientResult<PreloginResponse> {
        self.send(
            Method::POST,
            "/auth/prelogin",
            Some(&PreloginRequest {
                email: email.into(),
            }),
            false,
        )
        .await
    }

    pub async fn register(&self, req: &RegisterRequest) -> ClientResult<AuthResponse> {
        let r: AuthResponse = self
            .send(Method::POST, "/auth/register", Some(req), false)
            .await?;
        self.set_tokens(Some(Tokens {
            access_token: r.access_token.clone(),
            refresh_token: r.refresh_token.clone(),
        }));
        Ok(r)
    }

    pub async fn login(&self, req: &LoginRequest) -> ClientResult<AuthResponse> {
        let r: AuthResponse = self
            .send(Method::POST, "/auth/login", Some(req), false)
            .await?;
        self.set_tokens(Some(Tokens {
            access_token: r.access_token.clone(),
            refresh_token: r.refresh_token.clone(),
        }));
        Ok(r)
    }

    /// Refresh unless another task already replaced `stale_access_token` meanwhile.
    async fn refresh_if_stale(&self, stale_access_token: &str) -> ClientResult<()> {
        let _guard = self.refresh_lock.lock().await;
        match self.tokens() {
            Some(t) if t.access_token != stale_access_token => Ok(()),
            Some(_) => self.refresh_locked().await,
            None => Err(ClientError::NotSignedIn),
        }
    }

    pub async fn refresh(&self) -> ClientResult<()> {
        let _guard = self.refresh_lock.lock().await;
        self.refresh_locked().await
    }

    async fn refresh_locked(&self) -> ClientResult<()> {
        let refresh_token = self.tokens().ok_or(ClientError::NotSignedIn)?.refresh_token;
        let r: TokenResponse = self
            .send(
                Method::POST,
                "/auth/refresh",
                Some(&RefreshRequest { refresh_token }),
                false,
            )
            .await
            .map_err(|e| {
                if matches!(e, ClientError::Api { status: 401, .. }) {
                    self.set_tokens(None);
                    ClientError::NotSignedIn
                } else {
                    e
                }
            })?;
        self.set_tokens(Some(Tokens {
            access_token: r.access_token,
            refresh_token: r.refresh_token,
        }));
        Ok(())
    }

    pub async fn logout(&self) -> ClientResult<()> {
        let res: ClientResult<serde_json::Value> = self
            .authed::<(), _>(Method::POST, "/auth/logout", None)
            .await;
        self.set_tokens(None);
        res.map(|_| ())
    }

    pub async fn account_keys(&self) -> ClientResult<AccountKeys> {
        self.authed::<(), _>(Method::GET, "/account/keys", None)
            .await
    }

    pub async fn change_password(&self, req: &ChangePasswordRequest) -> ClientResult<()> {
        let _: serde_json::Value = self
            .authed(Method::POST, "/account/password", Some(req))
            .await?;
        Ok(())
    }

    pub async fn recover_challenge(
        &self,
        req: &RecoverChallengeRequest,
    ) -> ClientResult<RecoverChallengeResponse> {
        self.send(Method::POST, "/auth/recover/challenge", Some(req), false)
            .await
    }

    pub async fn recover(&self, req: &RecoverRequest) -> ClientResult<AuthResponse> {
        let r: AuthResponse = self
            .send(Method::POST, "/auth/recover", Some(req), false)
            .await?;
        self.set_tokens(Some(Tokens {
            access_token: r.access_token.clone(),
            refresh_token: r.refresh_token.clone(),
        }));
        Ok(r)
    }

    pub async fn devices(&self) -> ClientResult<Vec<Device>> {
        self.authed::<(), _>(Method::GET, "/devices", None).await
    }

    pub async fn revoke_device(&self, id: &str) -> ClientResult<()> {
        let _: serde_json::Value = self
            .authed::<(), _>(Method::DELETE, &format!("/devices/{id}"), None)
            .await?;
        Ok(())
    }

    pub async fn pull(&self, since: i64, limit: u32) -> ClientResult<PullResponse> {
        self.authed::<(), _>(
            Method::GET,
            &format!("/sync?since={since}&limit={limit}"),
            None,
        )
        .await
    }

    pub async fn push(&self, records: Vec<PushRecord>) -> ClientResult<PushResponse> {
        self.authed(Method::POST, "/sync", Some(&PushRequest { records }))
            .await
    }
}
