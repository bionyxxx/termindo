use anyhow::{bail, Context};

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: Vec<u8>,
    pub bind: String,
    pub allow_registration: bool,
    /// Use `X-Forwarded-For` for rate limiting (only when behind a trusted reverse proxy).
    pub trust_proxy: bool,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("bind", &self.bind)
            .field("allow_registration", &self.allow_registration)
            .field("trust_proxy", &self.trust_proxy)
            .finish_non_exhaustive()
    }
}

fn env_bool(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
        let jwt_secret =
            std::env::var("TERMINDO_JWT_SECRET").context("TERMINDO_JWT_SECRET is required")?;
        if jwt_secret.len() < 32 {
            bail!("TERMINDO_JWT_SECRET must be at least 32 characters");
        }
        Ok(Self {
            database_url,
            jwt_secret: jwt_secret.into_bytes(),
            bind: std::env::var("TERMINDO_BIND").unwrap_or_else(|_| "0.0.0.0:8080".into()),
            allow_registration: env_bool("TERMINDO_ALLOW_REGISTRATION", true),
            trust_proxy: env_bool("TERMINDO_TRUST_PROXY", false),
        })
    }
}
