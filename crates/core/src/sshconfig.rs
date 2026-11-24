//! Minimal OpenSSH client config (`~/.ssh/config`) import and export.
//!
//! Supported keywords: Host, HostName, Port, User, IdentityFile, ProxyJump.
//! Wildcard `Host` patterns are applied as defaults; `Match` blocks are skipped.

use serde::{Deserialize, Serialize};

use crate::models::{AuthType, Host};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedHost {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub user: Option<String>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

#[derive(Default, Clone)]
struct Block {
    patterns: Vec<String>,
    is_match: bool,
    hostname: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    identity_file: Option<String>,
    proxy_jump: Option<String>,
}

fn is_wildcard(p: &str) -> bool {
    p.contains('*') || p.contains('?') || p.starts_with('!')
}

/// Simple glob matching supporting `*` and `?`.
fn glob_match(pattern: &str, text: &str) -> bool {
    fn rec(p: &[u8], t: &[u8]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some(b'*'), _) => rec(&p[1..], t) || (!t.is_empty() && rec(p, &t[1..])),
            (Some(b'?'), Some(_)) => rec(&p[1..], &t[1..]),
            (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => rec(&p[1..], &t[1..]),
            _ => false,
        }
    }
    rec(pattern.as_bytes(), text.as_bytes())
}

fn split_kv(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let idx = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let key = line[..idx].to_ascii_lowercase();
    let value = line[idx..]
        .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
        .trim();
    let value = value.trim_matches('"').to_string();
    Some((key, value))
}

pub fn parse(content: &str) -> Vec<ImportedHost> {
    let mut blocks: Vec<Block> = Vec::new();
    let mut cur: Option<Block> = None;

    for line in content.lines() {
        let Some((key, value)) = split_kv(line) else {
            continue;
        };
        match key.as_str() {
            "host" => {
                if let Some(b) = cur.take() {
                    blocks.push(b);
                }
                cur = Some(Block {
                    patterns: value.split_whitespace().map(str::to_string).collect(),
                    ..Default::default()
                });
            }
            "match" => {
                if let Some(b) = cur.take() {
                    blocks.push(b);
                }
                cur = Some(Block {
                    is_match: true,
                    ..Default::default()
                });
            }
            _ => {
                // Options before the first Host line apply to every host.
                let b = cur.get_or_insert_with(|| Block {
                    patterns: vec!["*".into()],
                    ..Default::default()
                });
                // First obtained value wins (OpenSSH semantics).
                match key.as_str() {
                    "hostname" if b.hostname.is_none() => b.hostname = Some(value),
                    "port" if b.port.is_none() => b.port = value.parse().ok(),
                    "user" if b.user.is_none() => b.user = Some(value),
                    "identityfile" if b.identity_file.is_none() => b.identity_file = Some(value),
                    "proxyjump" if b.proxy_jump.is_none() => b.proxy_jump = Some(value),
                    _ => {}
                }
            }
        }
    }
    if let Some(b) = cur.take() {
        blocks.push(b);
    }

    let mut out = Vec::new();
    for b in blocks.iter().filter(|b| !b.is_match) {
        for alias in b.patterns.iter().filter(|p| !is_wildcard(p)) {
            // Resolve options in file order, first value wins, across all matching blocks.
            let mut h = ImportedHost {
                alias: alias.clone(),
                ..Default::default()
            };
            let mut hostname = None;
            let mut port = None;
            for m in blocks.iter().filter(|m| !m.is_match && matches(m, alias)) {
                hostname = hostname.or_else(|| m.hostname.clone());
                port = port.or(m.port);
                h.user = h.user.take().or_else(|| m.user.clone());
                h.identity_file = h.identity_file.take().or_else(|| m.identity_file.clone());
                h.proxy_jump = h.proxy_jump.take().or_else(|| m.proxy_jump.clone());
            }
            h.hostname = hostname
                .unwrap_or_else(|| alias.clone())
                .replace("%h", alias);
            h.port = port.unwrap_or(22);
            if !out.iter().any(|o: &ImportedHost| o.alias == h.alias) {
                out.push(h);
            }
        }
    }
    out
}

fn matches(block: &Block, alias: &str) -> bool {
    let mut matched = false;
    for p in &block.patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if glob_match(neg, alias) {
                return false;
            }
        } else if glob_match(p, alias) {
            matched = true;
        }
    }
    matched
}

/// Expand a leading `~/` using the given home directory.
pub fn expand_tilde(path: &str, home: Option<&std::path::Path>) -> std::path::PathBuf {
    match (path.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => std::path::PathBuf::from(path),
    }
}

fn alias_for(h: &Host) -> String {
    let base = if h.label.is_empty() {
        &h.hostname
    } else {
        &h.label
    };
    let alias: String = base
        .chars()
        .map(|c| {
            if c.is_whitespace() || c == '#' {
                '-'
            } else {
                c
            }
        })
        .collect();
    if alias.is_empty() {
        h.hostname.clone()
    } else {
        alias
    }
}

/// Render hosts as an OpenSSH config file.
pub fn export(hosts: &[Host]) -> String {
    let mut out = String::from("# Exported by Termindo\n");
    for h in hosts {
        out.push('\n');
        out.push_str(&format!("Host {}\n", alias_for(h)));
        out.push_str(&format!("    HostName {}\n", h.hostname));
        if h.port != 22 {
            out.push_str(&format!("    Port {}\n", h.port));
        }
        if !h.username.is_empty() {
            out.push_str(&format!("    User {}\n", h.username));
        }
        if let Some(jump) = h
            .jump_host_id
            .as_ref()
            .and_then(|id| hosts.iter().find(|j| &j.id == id))
        {
            out.push_str(&format!("    ProxyJump {}\n", alias_for(jump)));
        }
        if h.auth_type == AuthType::Key {
            out.push_str("    # private key stored in Termindo vault\n");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_config() {
        let cfg = r#"
User defaultuser

Host web prod-web
    HostName 10.0.0.5
    Port 2222
    IdentityFile ~/.ssh/id_ed25519

Host db
    HostName=db.internal
    User postgres
    ProxyJump web

Host *.example.com
    User example

Host api.example.com

Host *
    Port 2200
    User fallback

Match host foo
    User ignored
"#;
        let hosts = parse(cfg);
        let names: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, vec!["web", "prod-web", "db", "api.example.com"]);
        let web = &hosts[0];
        assert_eq!(web.hostname, "10.0.0.5");
        assert_eq!(web.port, 2222);
        assert_eq!(web.user.as_deref(), Some("defaultuser"));
        assert_eq!(web.identity_file.as_deref(), Some("~/.ssh/id_ed25519"));
        let db = &hosts[2];
        assert_eq!(db.hostname, "db.internal");
        // Leading global `User defaultuser` comes first in the file, so it wins.
        assert_eq!(db.user.as_deref(), Some("defaultuser"));
        assert_eq!(db.port, 2200);
        assert_eq!(db.proxy_jump.as_deref(), Some("web"));
        let api = &hosts[3];
        assert_eq!(api.hostname, "api.example.com");
    }

    #[test]
    fn glob() {
        assert!(glob_match("*.example.com", "a.example.com"));
        assert!(!glob_match("*.example.com", "example.org"));
        assert!(glob_match("h?st", "host"));
    }
}
