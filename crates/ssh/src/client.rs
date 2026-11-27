//! SSH connection setup and authentication.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect, MethodKind};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Result, SshError};
use crate::prompt_timeout;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Server host key presented during key exchange.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    /// Base64 key blob (second field of an OpenSSH public key line).
    pub key: String,
    /// `SHA256:...`
    pub fingerprint: String,
}

impl HostKeyInfo {
    pub fn from_key(host: &str, port: u16, key: &PublicKey) -> Self {
        let line = key.to_openssh().unwrap_or_default();
        let blob = line
            .split_whitespace()
            .nth(1)
            .unwrap_or_default()
            .to_string();
        Self {
            host: host.to_string(),
            port,
            key_type: key.algorithm().as_str().to_string(),
            key: blob,
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbdPrompt {
    pub prompt: String,
    pub echo: bool,
}

/// A keyboard-interactive challenge to show to the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbdRequest {
    pub host: String,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<KbdPrompt>,
}

/// UI callbacks needed while connecting. Implemented by the desktop app.
pub trait Interaction: Send + Sync + 'static {
    /// Decide whether to trust a server key (known_hosts check + user prompt).
    fn verify_host_key(&self, info: HostKeyInfo) -> BoxFuture<'_, bool>;
    /// Ask the user to answer keyboard-interactive prompts. `None` = cancelled.
    fn keyboard_interactive(&self, req: KbdRequest) -> BoxFuture<'_, Option<Vec<String>>>;
    /// Authentication banner sent by the server.
    fn banner(&self, _host: &str, _banner: &str) {}
}

/// Accepts every host key and fails keyboard-interactive. For tests only.
pub struct InsecureAcceptAll;

impl Interaction for InsecureAcceptAll {
    fn verify_host_key(&self, _info: HostKeyInfo) -> BoxFuture<'_, bool> {
        Box::pin(async { true })
    }
    fn keyboard_interactive(&self, _req: KbdRequest) -> BoxFuture<'_, Option<Vec<String>>> {
        Box::pin(async { None })
    }
}

#[derive(Clone)]
pub enum AuthMethod {
    Password(Zeroizing<String>),
    PrivateKey {
        pem: Zeroizing<String>,
        passphrase: Option<Zeroizing<String>>,
    },
    /// Keys from the running SSH agent (`SSH_AUTH_SOCK` / Pageant).
    Agent,
    /// Keyboard-interactive, prompting the user through [`Interaction`].
    Interactive,
}

impl std::fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            AuthMethod::Password(_) => "Password",
            AuthMethod::PrivateKey { .. } => "PrivateKey",
            AuthMethod::Agent => "Agent",
            AuthMethod::Interactive => "Interactive",
        })
    }
}

#[derive(Debug, Clone)]
pub struct ConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// Keepalive interval in seconds; 0 disables keepalives.
    pub keepalive_secs: u32,
    /// Limit per connection, not counting time spent waiting on [`Interaction`] prompts.
    pub connect_timeout: Duration,
    /// Optional jump host (ProxyJump); may itself have a jump host.
    pub jump: Option<Box<ConnectConfig>>,
}

impl ConnectConfig {
    pub fn new(
        host: impl Into<String>,
        port: u16,
        username: impl Into<String>,
        auth: AuthMethod,
    ) -> Self {
        Self {
            host: host.into(),
            port,
            username: username.into(),
            auth,
            keepalive_secs: 30,
            connect_timeout: Duration::from_secs(15),
            jump: None,
        }
    }

    fn target(&self) -> String {
        format!("{}@{}:{}", self.username, self.host, self.port)
    }
}

pub(crate) struct Handler {
    host: String,
    port: u16,
    interaction: Arc<dyn Interaction>,
}

impl client::Handler for Handler {
    type Error = SshError;

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.interaction.banner(&self.host, banner);
        Ok(())
    }

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::new(cert.public_key().clone(), "")
            }
        };
        let info = HostKeyInfo::from_key(&self.host, self.port, &key);
        let accepted = self.interaction.verify_host_key(info).await;
        if !accepted {
            return Err(SshError::HostKeyRejected(format!(
                "{}:{}",
                self.host, self.port
            )));
        }
        Ok(true)
    }
}

/// An authenticated SSH connection. Channels (shells, SFTP) are opened on it.
pub struct SshConnection {
    handle: client::Handle<Handler>,
    /// Keeps the jump-host connection alive for the lifetime of this one.
    _jump: Option<Box<SshConnection>>,
    target: String,
}

impl SshConnection {
    /// Connect and authenticate (recursively through jump hosts).
    pub fn connect(
        cfg: ConnectConfig,
        interaction: Arc<dyn Interaction>,
    ) -> BoxFuture<'static, Result<SshConnection>> {
        Box::pin(async move {
            let limit = cfg.connect_timeout;
            let (interaction, waiting) = prompt_timeout::track(interaction);
            let attempt = Self::connect_inner(cfg, interaction);
            prompt_timeout::timeout(limit, waiting, attempt)
                .await
                .unwrap_or(Err(SshError::Timeout))
        })
    }

    async fn connect_inner(
        cfg: ConnectConfig,
        interaction: Arc<dyn Interaction>,
    ) -> Result<SshConnection> {
        let config = Arc::new(client::Config {
            keepalive_interval: (cfg.keepalive_secs > 0)
                .then(|| Duration::from_secs(cfg.keepalive_secs as u64)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });
        let handler = Handler {
            host: cfg.host.clone(),
            port: cfg.port,
            interaction: interaction.clone(),
        };

        let (mut handle, jump) = match &cfg.jump {
            None => {
                let handle = client::connect(config, (cfg.host.as_str(), cfg.port), handler)
                    .await
                    .map_err(|e| match e {
                        SshError::Io(io) | SshError::Ssh(russh::Error::IO(io)) => {
                            SshError::Connect(io.to_string())
                        }
                        other => other,
                    })?;
                (handle, None)
            }
            Some(jump_cfg) => {
                let jump = Self::connect(*jump_cfg.clone(), interaction.clone()).await?;
                let channel = jump
                    .handle
                    .channel_open_direct_tcpip(cfg.host.clone(), cfg.port as u32, "127.0.0.1", 0)
                    .await
                    .map_err(|e| {
                        SshError::Connect(format!("jump host could not reach {}: {e}", cfg.host))
                    })?;
                let handle = client::connect_stream(config, channel.into_stream(), handler).await?;
                (handle, Some(Box::new(jump)))
            }
        };

        authenticate(&mut handle, &cfg, interaction.as_ref()).await?;
        tracing::info!(target = %cfg.target(), "ssh connected");
        Ok(SshConnection {
            handle,
            _jump: jump,
            target: cfg.target(),
        })
    }

    pub fn target(&self) -> &str {
        &self.target
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub(crate) fn handle(&self) -> &client::Handle<Handler> {
        &self.handle
    }

    /// Run a command and collect its stdout/stderr and exit status.
    pub async fn exec(&self, command: &str) -> Result<(Option<u32>, Vec<u8>)> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        let mut out = Vec::new();
        let mut status = None;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => out.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok((status, out))
    }

    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "bye", "en")
            .await;
    }
}

fn auth_failed(res: &AuthResult) -> Option<String> {
    match res {
        AuthResult::Success => None,
        AuthResult::Failure {
            remaining_methods, ..
        } => {
            let methods: Vec<&str> = remaining_methods.iter().map(method_name).collect();
            Some(if methods.is_empty() {
                "rejected by server".to_string()
            } else {
                format!(
                    "rejected by server (server accepts: {})",
                    methods.join(", ")
                )
            })
        }
    }
}

fn method_name(m: &MethodKind) -> &'static str {
    m.into()
}

async fn authenticate(
    handle: &mut client::Handle<Handler>,
    cfg: &ConnectConfig,
    ui: &dyn Interaction,
) -> Result<()> {
    let user = cfg.username.clone();
    match &cfg.auth {
        AuthMethod::Password(password) => {
            let res = handle
                .authenticate_password(user.clone(), password.as_str())
                .await?;
            let Some(err) = auth_failed(&res) else {
                return Ok(());
            };
            // Many servers disable "password" but accept the same password via keyboard-interactive.
            let kbd_allowed = matches!(&res, AuthResult::Failure { remaining_methods, .. }
                if remaining_methods.iter().any(|m| matches!(m, MethodKind::KeyboardInteractive)));
            if kbd_allowed
                && keyboard_interactive(handle, cfg, ui, Some(password.as_str()))
                    .await
                    .is_ok()
            {
                return Ok(());
            }
            Err(SshError::Auth(format!("password {err}")))
        }
        AuthMethod::PrivateKey { pem, passphrase } => {
            let key = russh::keys::decode_secret_key(pem, passphrase.as_ref().map(|p| p.as_str()))
                .map_err(|e| SshError::Auth(format!("cannot load private key: {e}")))?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();
            let res = handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?;
            match auth_failed(&res) {
                None => Ok(()),
                Some(err) => Err(SshError::Auth(format!("public key {err}"))),
            }
        }
        AuthMethod::Agent => agent_auth(handle, &user).await,
        AuthMethod::Interactive => keyboard_interactive(handle, cfg, ui, None).await,
    }
}

async fn keyboard_interactive(
    handle: &mut client::Handle<Handler>,
    cfg: &ConnectConfig,
    ui: &dyn Interaction,
    password: Option<&str>,
) -> Result<()> {
    let mut resp = handle
        .authenticate_keyboard_interactive_start(cfg.username.clone(), None::<String>)
        .await?;
    let mut password_used = false;
    loop {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(SshError::Auth(
                    "keyboard-interactive rejected by server".into(),
                ))
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else if let (Some(pw), true, false) = (
                    password,
                    prompts.len() == 1
                        && prompts[0].prompt.to_ascii_lowercase().contains("password"),
                    password_used,
                ) {
                    password_used = true;
                    vec![pw.to_string()]
                } else {
                    let req = KbdRequest {
                        host: cfg.host.clone(),
                        name,
                        instructions,
                        prompts: prompts
                            .iter()
                            .map(|p| KbdPrompt {
                                prompt: p.prompt.clone(),
                                echo: p.echo,
                            })
                            .collect(),
                    };
                    match ui.keyboard_interactive(req).await {
                        Some(a) => a,
                        None => return Err(SshError::Auth("cancelled by user".into())),
                    }
                };
                resp = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
}

#[cfg(unix)]
async fn agent_auth(handle: &mut client::Handle<Handler>, user: &str) -> Result<()> {
    use russh::keys::agent::client::AgentClient;

    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| SshError::Auth(format!("ssh-agent not available: {e}")))?;
    try_agent_identities(handle, user, &mut agent).await
}

#[cfg(windows)]
async fn agent_auth(handle: &mut client::Handle<Handler>, user: &str) -> Result<()> {
    use russh::keys::agent::client::AgentClient;
    // Prefer the OpenSSH for Windows agent, fall back to Pageant.
    match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        Ok(mut agent) => try_agent_identities(handle, user, &mut agent).await,
        Err(_) => {
            let mut agent = AgentClient::connect_pageant()
                .await
                .map_err(|e| SshError::Auth(format!("no ssh agent available: {e}")))?;
            try_agent_identities(handle, user, &mut agent).await
        }
    }
}

async fn try_agent_identities<S>(
    handle: &mut client::Handle<Handler>,
    user: &str,
    agent: &mut russh::keys::agent::client::AgentClient<S>,
) -> Result<()>
where
    S: russh::keys::agent::client::AgentStream
        + Unpin
        + Send
        + tokio::io::AsyncRead
        + tokio::io::AsyncWrite,
{
    use russh::keys::agent::AgentIdentity;

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::Auth(format!("ssh-agent error: {e}")))?;
    if identities.is_empty() {
        return Err(SshError::Auth("ssh-agent has no keys loaded".into()));
    }
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten();
    for id in identities {
        let AgentIdentity::PublicKey { key, .. } = id else {
            continue;
        };
        match handle
            .authenticate_publickey_with(user.to_string(), key, hash, agent)
            .await
        {
            Ok(AuthResult::Success) => return Ok(()),
            Ok(_) => continue,
            Err(e) => tracing::debug!("agent signing failed: {e}"),
        }
    }
    Err(SshError::Auth("no ssh-agent key was accepted".into()))
}
