//! JSON / CSV backup of non-secret data (groups, hosts, snippets, known hosts).
//! Credentials are never exported in plaintext.

use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::models::*;
use crate::{new_id, Error, Result};

pub const BACKUP_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub version: u32,
    pub exported_at: i64,
    pub groups: Vec<Group>,
    pub hosts: Vec<Host>,
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub known_hosts: Vec<KnownHost>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub groups: usize,
    pub hosts: usize,
    pub snippets: usize,
    pub known_hosts: usize,
}

pub fn export_json(db: &Db) -> Result<String> {
    let backup = Backup {
        version: BACKUP_VERSION,
        exported_at: crate::now_ms(),
        groups: db.list()?,
        hosts: db.list()?,
        snippets: db.list()?,
        known_hosts: db.list()?,
    };
    Ok(serde_json::to_string_pretty(&backup)?)
}

/// Import a JSON backup. Records with an existing id are overwritten; credential
/// references that don't exist locally are dropped.
pub fn import_json(db: &Db, json: &str) -> Result<ImportSummary> {
    let backup: Backup = serde_json::from_str(json)?;
    if backup.version > BACKUP_VERSION {
        return Err(Error::Invalid(format!(
            "backup version {} is newer than supported",
            backup.version
        )));
    }
    let mut summary = ImportSummary::default();
    let tx = db.conn().unchecked_transaction()?;
    for mut g in backup.groups {
        g.deleted_at = None;
        db.save(&mut g)?;
        summary.groups += 1;
    }
    for mut h in backup.hosts {
        h.deleted_at = None;
        if let Some(cid) = &h.credential_id {
            if db.get::<Credential>(cid).is_err() {
                h.credential_id = None;
            }
        }
        db.save(&mut h)?;
        summary.hosts += 1;
    }
    for mut s in backup.snippets {
        s.deleted_at = None;
        db.save(&mut s)?;
        summary.snippets += 1;
    }
    for mut k in backup.known_hosts {
        k.deleted_at = None;
        db.save(&mut k)?;
        summary.known_hosts += 1;
    }
    tx.commit()?;
    Ok(summary)
}

fn csv_escape(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn csv_parse_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, in_quotes) {
            ('"', true) if chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            ('"', true) => in_quotes = false,
            ('"', false) if cur.is_empty() => in_quotes = true,
            (',', false) => fields.push(std::mem::take(&mut cur)),
            (c, _) => cur.push(c),
        }
    }
    fields.push(cur);
    fields
}

const CSV_HEADER: &str = "label,hostname,port,username,group,tags";

pub fn export_hosts_csv(db: &Db) -> Result<String> {
    let groups: Vec<Group> = db.list()?;
    let mut out = String::from(CSV_HEADER);
    out.push('\n');
    for h in db.list::<Host>()? {
        let group = h
            .group_id
            .as_ref()
            .and_then(|id| groups.iter().find(|g| &g.id == id))
            .map(|g| g.name.clone())
            .unwrap_or_default();
        out.push_str(
            &[
                csv_escape(&h.label),
                csv_escape(&h.hostname),
                h.port.to_string(),
                csv_escape(&h.username),
                csv_escape(&group),
                csv_escape(&h.tags.join(";")),
            ]
            .join(","),
        );
        out.push('\n');
    }
    Ok(out)
}

/// Import hosts from CSV (`label,hostname,port,username,group,tags`). Groups are created by name.
pub fn import_hosts_csv(db: &Db, csv: &str) -> Result<usize> {
    let mut groups: Vec<Group> = db.list()?;
    let mut count = 0;
    let tx = db.conn().unchecked_transaction()?;
    for (i, line) in csv.lines().enumerate() {
        if line.trim().is_empty() || (i == 0 && line.trim().eq_ignore_ascii_case(CSV_HEADER)) {
            continue;
        }
        let f = csv_parse_line(line);
        let get = |n: usize| f.get(n).map(|s| s.trim().to_string()).unwrap_or_default();
        let hostname = get(1);
        if hostname.is_empty() {
            return Err(Error::Invalid(format!(
                "line {}: hostname is required",
                i + 1
            )));
        }
        let group_name = get(4);
        let group_id = if group_name.is_empty() {
            None
        } else if let Some(g) = groups.iter().find(|g| g.name == group_name) {
            Some(g.id.clone())
        } else {
            let mut g = Group {
                id: new_id(),
                name: group_name,
                parent_id: None,
                icon: None,
                color: None,
                sort_order: 0,
                updated_at: 0,
                deleted_at: None,
            };
            db.save(&mut g)?;
            let id = g.id.clone();
            groups.push(g);
            Some(id)
        };
        let mut h = Host {
            id: new_id(),
            group_id,
            label: get(0),
            hostname,
            port: get(2).parse().unwrap_or(22),
            username: get(3),
            auth_type: AuthType::Password,
            credential_id: None,
            jump_host_id: None,
            tags: get(5)
                .split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect(),
            options: HostOptions::default(),
            notes: String::new(),
            updated_at: 0,
            deleted_at: None,
        };
        db.save(&mut h)?;
        count += 1;
    }
    tx.commit()?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let n = import_hosts_csv(&db, "label,hostname,port,username,group,tags\n\"Web, main\",10.0.0.1,2222,root,Prod,a;b\nx,y.local,,,,\n").unwrap();
        assert_eq!(n, 2);
        let csv = export_hosts_csv(&db).unwrap();
        assert!(csv.contains("\"Web, main\",10.0.0.1,2222,root,Prod,a;b"));

        let json = export_json(&db).unwrap();
        let db2 = Db::open_in_memory().unwrap();
        let s = import_json(&db2, &json).unwrap();
        assert_eq!(s.hosts, 2);
        assert_eq!(s.groups, 1);
    }
}
