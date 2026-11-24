//! CRUD for groups, hosts, credentials, snippets, known hosts; settings; import/export.

use serde::{Deserialize, Serialize};
use tauri::State;
use termindo_core::models::*;
use termindo_core::{backup, new_id, snippet, sshconfig, vault};
use zeroize::Zeroizing;

use crate::error::{CmdError, CmdResult};
use crate::state::AppState;

fn changed(state: &AppState) {
    state.sync.schedule();
}

// -- groups ---------------------------------------------------------------------

#[tauri::command]
pub fn groups_list(state: State<'_, AppState>) -> CmdResult<Vec<Group>> {
    let mut groups: Vec<Group> = state.db().list()?;
    groups.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(groups)
}

#[tauri::command]
pub fn group_save(state: State<'_, AppState>, mut group: Group) -> CmdResult<Group> {
    if group.name.trim().is_empty() {
        return Err(CmdError::invalid("group name is required"));
    }
    if group.id.is_empty() {
        group.id = new_id();
    }
    // Prevent cycles: a group can't be moved under itself or its descendants.
    if let Some(parent) = &group.parent_id {
        let all: Vec<Group> = state.db().list()?;
        let mut cur = Some(parent.clone());
        while let Some(id) = cur {
            if id == group.id {
                return Err(CmdError::invalid("a group cannot be nested inside itself"));
            }
            cur = all
                .iter()
                .find(|g| g.id == id)
                .and_then(|g| g.parent_id.clone());
        }
    }
    group.deleted_at = None;
    state.db().save(&mut group)?;
    changed(&state);
    Ok(group)
}

#[tauri::command]
pub fn group_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.db().delete_group(&id)?;
    changed(&state);
    Ok(())
}

// -- hosts ------------------------------------------------------------------------

#[tauri::command]
pub fn hosts_list(state: State<'_, AppState>) -> CmdResult<Vec<Host>> {
    let mut hosts: Vec<Host> = state.db().list()?;
    hosts.sort_by_key(|a| a.display_name().to_lowercase());
    Ok(hosts)
}

#[tauri::command]
pub fn host_save(state: State<'_, AppState>, mut host: Host) -> CmdResult<Host> {
    host.hostname = host.hostname.trim().to_string();
    if host.hostname.is_empty() {
        return Err(CmdError::invalid("hostname is required"));
    }
    if host.port == 0 {
        host.port = 22;
    }
    if host.id.is_empty() {
        host.id = new_id();
    }
    if host.jump_host_id.as_deref() == Some(host.id.as_str()) {
        return Err(CmdError::invalid("a host cannot be its own jump host"));
    }
    host.tags = host
        .tags
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    host.deleted_at = None;
    state.db().save(&mut host)?;
    changed(&state);
    Ok(host)
}

#[tauri::command]
pub fn host_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let db = state.db();
    for mut h in db
        .list::<Host>()?
        .into_iter()
        .filter(|h| h.jump_host_id.as_deref() == Some(id.as_str()))
    {
        h.jump_host_id = None;
        db.save(&mut h)?;
    }
    db.delete::<Host>(&id)?;
    drop(db);
    changed(&state);
    Ok(())
}

#[tauri::command]
pub fn host_duplicate(state: State<'_, AppState>, id: String) -> CmdResult<Host> {
    let mut h: Host = state.db().get(&id)?;
    h.id = new_id();
    h.label = format!("{} (copy)", h.display_name());
    state.db().save(&mut h)?;
    changed(&state);
    Ok(h)
}

#[tauri::command]
pub fn host_stats(state: State<'_, AppState>) -> CmdResult<Vec<HostStats>> {
    Ok(state.db().host_stats()?)
}

#[tauri::command]
pub fn history_list(
    state: State<'_, AppState>,
    host_id: Option<String>,
    limit: Option<i64>,
) -> CmdResult<Vec<ConnectionLog>> {
    Ok(state
        .db()
        .connection_history(host_id.as_deref(), limit.unwrap_or(100).clamp(1, 1000))?)
}

// -- credentials -------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub id: Option<String>,
    pub label: String,
    pub kind: CredentialKind,
    /// `None` keeps the stored secret when editing.
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

pub fn decrypt_secret(state: &AppState, cred: &Credential) -> CmdResult<CredentialSecret> {
    let keys = state.keys()?;
    let plain = vault::decrypt_field(&keys.dek, &cred.id, &cred.data_enc)?;
    Ok(serde_json::from_slice(&plain)?)
}

fn encrypt_secret(state: &AppState, id: &str, secret: &CredentialSecret) -> CmdResult<Vec<u8>> {
    let keys = state.keys()?;
    let json = Zeroizing::new(serde_json::to_vec(secret)?);
    Ok(vault::encrypt_field(&keys.dek, id, &json)?)
}

fn public_key_for(secret: &CredentialSecret) -> CmdResult<Option<String>> {
    match &secret.private_key {
        Some(pem) => {
            let info = termindo_ssh::keys::inspect_private_key(pem, secret.passphrase.as_deref())?;
            Ok(Some(info.public_key))
        }
        None => Ok(None),
    }
}

pub fn store_credential(state: &AppState, input: CredentialInput) -> CmdResult<CredentialInfo> {
    let id = input
        .id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(new_id);
    let existing: Option<Credential> = state
        .db()
        .get_any(&id)?
        .filter(|c: &Credential| c.deleted_at.is_none());
    let mut secret = match &existing {
        Some(c) => decrypt_secret(state, c)?,
        None => CredentialSecret::default(),
    };
    match input.kind {
        CredentialKind::Password => {
            if let Some(p) = input.password {
                secret = CredentialSecret {
                    password: Some(p),
                    private_key: None,
                    passphrase: None,
                };
            } else if existing.is_none() {
                return Err(CmdError::invalid("password is required"));
            }
        }
        CredentialKind::PrivateKey => {
            if let Some(k) = input.private_key.filter(|k| !k.trim().is_empty()) {
                secret.private_key = Some(k.trim().to_string() + "\n");
                secret.password = None;
            } else if secret.private_key.is_none() {
                return Err(CmdError::invalid("private key is required"));
            }
            if let Some(p) = input.passphrase {
                secret.passphrase = if p.is_empty() { None } else { Some(p) };
            }
        }
    }
    let public_key = match input.kind {
        CredentialKind::PrivateKey => public_key_for(&secret)?,
        CredentialKind::Password => None,
    };
    let mut cred = Credential {
        id: id.clone(),
        label: if input.label.trim().is_empty() {
            "Untitled".into()
        } else {
            input.label.trim().to_string()
        },
        kind: input.kind,
        public_key,
        data_enc: encrypt_secret(state, &id, &secret)?,
        updated_at: 0,
        deleted_at: None,
    };
    state.db().save(&mut cred)?;
    changed(state);
    Ok(CredentialInfo::from(&cred))
}

#[tauri::command]
pub fn credentials_list(state: State<'_, AppState>) -> CmdResult<Vec<CredentialInfo>> {
    let mut list: Vec<CredentialInfo> = state
        .db()
        .list::<Credential>()?
        .iter()
        .map(CredentialInfo::from)
        .collect();
    list.sort_by_key(|a| a.label.to_lowercase());
    Ok(list)
}

#[tauri::command]
pub fn credential_save(
    state: State<'_, AppState>,
    input: CredentialInput,
) -> CmdResult<CredentialInfo> {
    store_credential(&state, input)
}

#[tauri::command]
pub fn credential_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.db().delete_credential(&id)?;
    changed(&state);
    Ok(())
}

/// Reveal a stored password / private key (e.g. to copy it). Requires an unlocked vault.
#[tauri::command]
pub fn credential_reveal(state: State<'_, AppState>, id: String) -> CmdResult<CredentialSecret> {
    let cred: Credential = state.db().get(&id)?;
    decrypt_secret(&state, &cred)
}

#[tauri::command]
pub fn credential_generate_key(
    state: State<'_, AppState>,
    label: String,
) -> CmdResult<CredentialInfo> {
    let comment = format!(
        "{}@termindo",
        label.trim().replace(char::is_whitespace, "-")
    );
    let (private, _public) = termindo_ssh::keys::generate_ed25519(&comment)?;
    store_credential(
        &state,
        CredentialInput {
            id: None,
            label,
            kind: CredentialKind::PrivateKey,
            password: None,
            private_key: Some(private.to_string()),
            passphrase: None,
        },
    )
}

#[tauri::command]
pub fn credential_import_key_file(
    state: State<'_, AppState>,
    path: String,
    label: Option<String>,
    passphrase: Option<String>,
) -> CmdResult<CredentialInfo> {
    let pem = Zeroizing::new(std::fs::read_to_string(&path)?);
    let label = label.filter(|l| !l.trim().is_empty()).unwrap_or_else(|| {
        std::path::Path::new(&path)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| "key".into())
    });
    store_credential(
        &state,
        CredentialInput {
            id: None,
            label,
            kind: CredentialKind::PrivateKey,
            password: None,
            private_key: Some(pem.to_string()),
            passphrase,
        },
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInspection {
    pub encrypted: bool,
    pub info: Option<termindo_ssh::keys::KeyInfo>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn key_inspect(private_key: String, passphrase: Option<String>) -> KeyInspection {
    let encrypted = termindo_ssh::keys::is_encrypted(&private_key);
    match termindo_ssh::keys::inspect_private_key(
        &private_key,
        passphrase.as_deref().filter(|p| !p.is_empty()),
    ) {
        Ok(info) => KeyInspection {
            encrypted,
            info: Some(info),
            error: None,
        },
        Err(e) => KeyInspection {
            encrypted,
            info: None,
            error: Some(e.to_string()),
        },
    }
}

// -- snippets ------------------------------------------------------------------------

#[tauri::command]
pub fn snippets_list(state: State<'_, AppState>) -> CmdResult<Vec<Snippet>> {
    let mut list: Vec<Snippet> = state.db().list()?;
    list.sort_by_key(|a| a.name.to_lowercase());
    Ok(list)
}

#[tauri::command]
pub fn snippet_save(state: State<'_, AppState>, mut snippet: Snippet) -> CmdResult<Snippet> {
    if snippet.name.trim().is_empty() {
        return Err(CmdError::invalid("snippet name is required"));
    }
    if snippet.id.is_empty() {
        snippet.id = new_id();
    }
    snippet.deleted_at = None;
    state.db().save(&mut snippet)?;
    changed(&state);
    Ok(snippet)
}

#[tauri::command]
pub fn snippet_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.db().delete::<Snippet>(&id)?;
    changed(&state);
    Ok(())
}

/// Placeholders the user must fill in (built-ins like `{{host}}` are filled automatically).
#[tauri::command]
pub fn snippet_placeholders(body: String) -> Vec<String> {
    snippet::custom_placeholders(&body)
}

// -- known hosts ----------------------------------------------------------------------

#[tauri::command]
pub fn known_hosts_list(state: State<'_, AppState>) -> CmdResult<Vec<KnownHost>> {
    let mut list: Vec<KnownHost> = state.db().list()?;
    list.sort_by(|a, b| a.host.cmp(&b.host).then(a.port.cmp(&b.port)));
    Ok(list)
}

#[tauri::command]
pub fn known_host_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.db().delete::<KnownHost>(&id)?;
    changed(&state);
    Ok(())
}

// -- settings (local only) --------------------------------------------------------------

#[tauri::command]
pub fn setting_get(state: State<'_, AppState>, key: String) -> CmdResult<Option<String>> {
    Ok(state.db().setting(&format!("ui.{key}"))?)
}

#[tauri::command]
pub fn setting_set(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    Ok(state.db().set_setting(&format!("ui.{key}"), &value)?)
}

// -- import / export ---------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigImport {
    pub hosts: usize,
    pub skipped: usize,
    pub keys: usize,
    pub warnings: Vec<String>,
}

fn default_ssh_config() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("config"))
}

/// Import hosts from an OpenSSH config file (default `~/.ssh/config`).
/// IdentityFile keys are imported into the vault; ProxyJump is linked when the alias exists.
#[tauri::command]
pub fn import_ssh_config(
    state: State<'_, AppState>,
    path: Option<String>,
) -> CmdResult<SshConfigImport> {
    state.keys()?;
    let path = path
        .map(std::path::PathBuf::from)
        .or_else(default_ssh_config)
        .ok_or_else(|| CmdError::invalid("no path"))?;
    let content = std::fs::read_to_string(&path)?;
    let parsed = sshconfig::parse(&content);
    let home = dirs::home_dir();
    let mut result = SshConfigImport {
        hosts: 0,
        skipped: 0,
        keys: 0,
        warnings: Vec::new(),
    };

    let existing: Vec<Host> = state.db().list()?;
    let mut key_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut alias_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut created: Vec<(Host, Option<String>)> = Vec::new();

    for ih in parsed {
        let user = ih.user.clone().unwrap_or_default();
        if let Some(h) = existing.iter().find(|h| {
            h.label == ih.alias
                || (h.hostname == ih.hostname && h.port == ih.port && h.username == user)
        }) {
            alias_ids.insert(ih.alias.clone(), h.id.clone());
            result.skipped += 1;
            continue;
        }
        let mut host = Host {
            id: new_id(),
            group_id: None,
            label: ih.alias.clone(),
            hostname: ih.hostname.clone(),
            port: ih.port,
            username: user,
            auth_type: AuthType::Password,
            credential_id: None,
            jump_host_id: None,
            tags: vec!["ssh-config".into()],
            options: HostOptions::default(),
            notes: String::new(),
            updated_at: 0,
            deleted_at: None,
        };
        if let Some(file) = &ih.identity_file {
            let key_path = sshconfig::expand_tilde(file, home.as_deref());
            let key_path_str = key_path.to_string_lossy().into_owned();
            let cred_id = match key_ids.get(&key_path_str) {
                Some(id) => Some(id.clone()),
                None => match std::fs::read_to_string(&key_path) {
                    Ok(pem) => {
                        let label = key_path
                            .file_name()
                            .map(|f| f.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        let encrypted = termindo_ssh::keys::is_encrypted(&pem);
                        let stored = if encrypted {
                            // Can't derive the public key without the passphrase; store as-is.
                            let id = new_id();
                            let secret = CredentialSecret {
                                password: None,
                                private_key: Some(pem),
                                passphrase: None,
                            };
                            let mut cred = Credential {
                                id: id.clone(),
                                label: format!("{label} (needs passphrase)"),
                                kind: CredentialKind::PrivateKey,
                                public_key: None,
                                data_enc: encrypt_secret(&state, &id, &secret)?,
                                updated_at: 0,
                                deleted_at: None,
                            };
                            state.db().save(&mut cred)?;
                            Ok(CredentialInfo::from(&cred))
                        } else {
                            store_credential(
                                &state,
                                CredentialInput {
                                    id: None,
                                    label,
                                    kind: CredentialKind::PrivateKey,
                                    password: None,
                                    private_key: Some(pem),
                                    passphrase: None,
                                },
                            )
                        };
                        match stored {
                            Ok(info) => {
                                result.keys += 1;
                                key_ids.insert(key_path_str.clone(), info.id.clone());
                                Some(info.id)
                            }
                            Err(e) => {
                                result
                                    .warnings
                                    .push(format!("{}: {}", key_path_str, e.message));
                                None
                            }
                        }
                    }
                    Err(e) => {
                        result.warnings.push(format!("{}: {}", key_path_str, e));
                        None
                    }
                },
            };
            if let Some(cid) = cred_id {
                host.auth_type = AuthType::Key;
                host.credential_id = Some(cid);
            }
        }
        alias_ids.insert(ih.alias.clone(), host.id.clone());
        created.push((host, ih.proxy_jump.clone()));
    }

    let db = state.db();
    for (mut host, jump) in created {
        if let Some(j) = jump {
            // Only the first hop of a ProxyJump chain is linked; user@host:port forms are matched by alias.
            let first = j.split(',').next().unwrap_or_default().trim().to_string();
            match alias_ids.get(&first) {
                Some(id) => host.jump_host_id = Some(id.clone()),
                None => result.warnings.push(format!(
                    "{}: ProxyJump '{}' is not a known host alias",
                    host.label, first
                )),
            }
        }
        db.save(&mut host)?;
        result.hosts += 1;
    }
    drop(db);
    changed(&state);
    Ok(result)
}

#[tauri::command]
pub fn export_ssh_config(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    let hosts: Vec<Host> = state.db().list()?;
    std::fs::write(path, sshconfig::export(&hosts))?;
    Ok(())
}

#[tauri::command]
pub fn export_backup(state: State<'_, AppState>, path: String, format: String) -> CmdResult<()> {
    let content = match format.as_str() {
        "csv" => backup::export_hosts_csv(&state.db())?,
        _ => backup::export_json(&state.db())?,
    };
    std::fs::write(path, content)?;
    Ok(())
}

#[tauri::command]
pub fn import_backup(state: State<'_, AppState>, path: String) -> CmdResult<backup::ImportSummary> {
    let content = std::fs::read_to_string(&path)?;
    let summary = if path.to_ascii_lowercase().ends_with(".csv") {
        let n = backup::import_hosts_csv(&state.db(), &content)?;
        backup::ImportSummary {
            hosts: n,
            ..Default::default()
        }
    } else {
        backup::import_json(&state.db(), &content)?
    };
    changed(&state);
    Ok(summary)
}
