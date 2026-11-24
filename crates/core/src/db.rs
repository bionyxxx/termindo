//! Local SQLite database (offline-first: every UI operation hits this first).

use std::path::Path;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use crate::models::*;
use crate::vault::VaultMeta;
use crate::{now_ms, Error, Result};

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE vault (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        meta TEXT NOT NULL
    );
    CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT,
        icon TEXT,
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE hosts (
        id TEXT PRIMARY KEY,
        group_id TEXT,
        label TEXT NOT NULL,
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL DEFAULT '',
        auth_type TEXT NOT NULL DEFAULT 'password',
        credential_id TEXT,
        jump_host_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        options TEXT NOT NULL DEFAULT '{}',
        notes TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX hosts_group ON hosts(group_id);
    CREATE TABLE credentials (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        public_key TEXT,
        data_enc BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE snippets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        hotkey TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE known_hosts (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        key_type TEXT NOT NULL,
        key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        dirty INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE connection_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        success INTEGER NOT NULL,
        error TEXT
    );
    CREATE INDEX history_host ON connection_history(host_id, started_at);
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
];

/// Every synced table, used for bulk operations (re-keying, "mark all dirty").
pub const SYNCED_TABLES: &[&str] = &["groups", "hosts", "credentials", "snippets", "known_hosts"];

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&mut self) -> Result<()> {
        let version: i64 = self
            .conn
            .pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            tx.commit()?;
            tracing::info!(version = i + 1, "applied database migration");
        }
        Ok(())
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    // -- vault ---------------------------------------------------------------

    pub fn vault_meta(&self) -> Result<Option<VaultMeta>> {
        let s: Option<String> = self
            .conn
            .query_row("SELECT meta FROM vault WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        Ok(match s {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        })
    }

    pub fn set_vault_meta(&self, meta: &VaultMeta) -> Result<()> {
        self.conn.execute(
            "INSERT INTO vault (id, meta) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET meta = excluded.meta",
            [serde_json::to_string(meta)?],
        )?;
        Ok(())
    }

    // -- generic entity access ----------------------------------------------

    fn select_sql<T: Entity>() -> String {
        format!("SELECT {} FROM {}", T::COLUMNS.join(", "), T::TABLE)
    }

    /// All live (not deleted) records.
    pub fn list<T: Entity>(&self) -> Result<Vec<T>> {
        let sql = format!("{} WHERE deleted_at IS NULL", Self::select_sql::<T>());
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| T::from_row(r))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Record by id, including tombstones.
    pub fn get_any<T: Entity>(&self, id: &str) -> Result<Option<T>> {
        let sql = format!("{} WHERE id = ?1", Self::select_sql::<T>());
        Ok(self
            .conn
            .query_row(&sql, [id], |r| T::from_row(r))
            .optional()?)
    }

    /// Live record by id.
    pub fn get<T: Entity>(&self, id: &str) -> Result<T> {
        match self.get_any::<T>(id)? {
            Some(t) if t.deleted_at().is_none() => Ok(t),
            _ => Err(Error::NotFound(format!("{} {}", T::KIND, id))),
        }
    }

    fn write<T: Entity>(&self, item: &T, dirty: bool) -> Result<()> {
        let cols = T::COLUMNS;
        let placeholders = (1..=cols.len() + 1)
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT OR REPLACE INTO {} ({}, dirty) VALUES ({})",
            T::TABLE,
            cols.join(", "),
            placeholders
        );
        let mut values = item.to_values();
        values.push(rusqlite::types::Value::Integer(dirty as i64));
        self.conn.execute(&sql, params_from_iter(values))?;
        Ok(())
    }

    /// Insert or update a record from a local edit: bumps `updated_at` and marks it dirty.
    pub fn save<T: Entity>(&self, item: &mut T) -> Result<()> {
        let prev = self
            .get_any::<T>(item.id())?
            .map(|p| p.updated_at())
            .unwrap_or(0);
        item.set_updated_at(now_ms().max(prev + 1));
        self.write(item, true)
    }

    /// Soft-delete (tombstone) so the deletion propagates through sync.
    pub fn delete<T: Entity>(&self, id: &str) -> Result<()> {
        let mut item: T = self.get(id)?;
        let now = now_ms().max(item.updated_at() + 1);
        item.set_deleted_at(Some(now));
        item.set_updated_at(now);
        self.write(&item, true)
    }

    /// Apply a record received from sync. Last-write-wins on `updated_at`;
    /// returns `true` when the local copy was replaced.
    pub fn apply_remote<T: Entity>(&self, item: &T) -> Result<bool> {
        if let Some(local) = self.get_any::<T>(item.id())? {
            if local.updated_at() > item.updated_at() {
                return Ok(false);
            }
            if local.updated_at() == item.updated_at() {
                // Same version (e.g. echo of our own push): just make sure it's clean.
                self.mark_clean::<T>(item.id(), item.updated_at())?;
                return Ok(false);
            }
        }
        self.write(item, false)?;
        Ok(true)
    }

    /// Records changed locally since the last successful push (tombstones included).
    pub fn dirty<T: Entity>(&self) -> Result<Vec<T>> {
        let sql = format!("{} WHERE dirty = 1", Self::select_sql::<T>());
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| T::from_row(r))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Clear the dirty flag only if the record was not modified again meanwhile.
    pub fn mark_clean<T: Entity>(&self, id: &str, updated_at: i64) -> Result<()> {
        self.conn.execute(
            &format!(
                "UPDATE {} SET dirty = 0 WHERE id = ?1 AND updated_at = ?2",
                T::TABLE
            ),
            params![id, updated_at],
        )?;
        Ok(())
    }

    /// Mark every record dirty (used after first login so everything gets uploaded).
    pub fn mark_all_dirty(&self) -> Result<()> {
        for t in SYNCED_TABLES {
            self.conn
                .execute(&format!("UPDATE {t} SET dirty = 1"), [])?;
        }
        Ok(())
    }

    // -- entity specific helpers --------------------------------------------

    /// Delete a group: its hosts and sub-groups move up to the parent group.
    pub fn delete_group(&self, id: &str) -> Result<()> {
        let group: Group = self.get(id)?;
        for mut h in self
            .list::<Host>()?
            .into_iter()
            .filter(|h| h.group_id.as_deref() == Some(id))
        {
            h.group_id = group.parent_id.clone();
            self.save(&mut h)?;
        }
        for mut g in self
            .list::<Group>()?
            .into_iter()
            .filter(|g| g.parent_id.as_deref() == Some(id))
        {
            g.parent_id = group.parent_id.clone();
            self.save(&mut g)?;
        }
        self.delete::<Group>(id)
    }

    /// Delete a credential and detach it from hosts that used it.
    pub fn delete_credential(&self, id: &str) -> Result<()> {
        for mut h in self
            .list::<Host>()?
            .into_iter()
            .filter(|h| h.credential_id.as_deref() == Some(id))
        {
            h.credential_id = None;
            self.save(&mut h)?;
        }
        self.delete::<Credential>(id)
    }

    pub fn known_host(&self, host: &str, port: u16) -> Result<Option<KnownHost>> {
        Ok(self
            .get_any::<KnownHost>(&KnownHost::make_id(host, port))?
            .filter(|k| k.deleted_at.is_none()))
    }

    // -- connection history (local only) ---------------------------------------

    pub fn log_connection_start(
        &self,
        host_id: &str,
        success: bool,
        error: Option<&str>,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO connection_history (host_id, started_at, success, error) VALUES (?1, ?2, ?3, ?4)",
            params![host_id, now_ms(), success, error],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn log_connection_end(&self, log_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE connection_history SET ended_at = ?2 WHERE id = ?1",
            params![log_id, now_ms()],
        )?;
        Ok(())
    }

    pub fn connection_history(
        &self,
        host_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<ConnectionLog>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, host_id, started_at, ended_at, success, error FROM connection_history
             WHERE (?1 IS NULL OR host_id = ?1) ORDER BY started_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![host_id, limit], |r| {
            Ok(ConnectionLog {
                id: r.get(0)?,
                host_id: r.get(1)?,
                started_at: r.get(2)?,
                ended_at: r.get(3)?,
                success: r.get(4)?,
                error: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn host_stats(&self) -> Result<Vec<HostStats>> {
        let mut stmt = self.conn.prepare(
            "SELECT host_id, COUNT(*), SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END),
                    MAX(CASE WHEN success = 1 THEN started_at END)
             FROM connection_history GROUP BY host_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(HostStats {
                host_id: r.get(0)?,
                connections: r.get(1)?,
                failures: r.get(2)?,
                last_connected_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // -- key/value stores ------------------------------------------------------

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn sync_value(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM sync_meta WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_sync_value(&self, key: &str, value: Option<&str>) -> Result<()> {
        match value {
            Some(v) => self.conn.execute(
                "INSERT INTO sync_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, v],
            )?,
            None => self.conn.execute("DELETE FROM sync_meta WHERE key = ?1", [key])?,
        };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::new_id;

    fn host(label: &str) -> Host {
        Host {
            id: new_id(),
            group_id: None,
            label: label.into(),
            hostname: "example.com".into(),
            port: 22,
            username: "root".into(),
            auth_type: AuthType::Password,
            credential_id: None,
            jump_host_id: None,
            tags: vec!["prod".into()],
            options: HostOptions::default(),
            notes: String::new(),
            updated_at: 0,
            deleted_at: None,
        }
    }

    #[test]
    fn crud_and_tombstones() {
        let db = Db::open_in_memory().unwrap();
        let mut h = host("web");
        db.save(&mut h).unwrap();
        assert!(h.updated_at > 0);
        let got: Host = db.get(&h.id).unwrap();
        assert_eq!(got, h);
        assert_eq!(db.list::<Host>().unwrap().len(), 1);
        assert_eq!(db.dirty::<Host>().unwrap().len(), 1);

        db.mark_clean::<Host>(&h.id, h.updated_at).unwrap();
        assert!(db.dirty::<Host>().unwrap().is_empty());

        db.delete::<Host>(&h.id).unwrap();
        assert!(db.list::<Host>().unwrap().is_empty());
        let tomb: Host = db.get_any(&h.id).unwrap().unwrap();
        assert!(tomb.deleted_at.is_some());
        assert_eq!(db.dirty::<Host>().unwrap().len(), 1);
    }

    #[test]
    fn last_write_wins() {
        let db = Db::open_in_memory().unwrap();
        let mut h = host("local");
        db.save(&mut h).unwrap();

        let mut older = h.clone();
        older.label = "older".into();
        older.updated_at = h.updated_at - 10;
        assert!(!db.apply_remote(&older).unwrap());
        assert_eq!(db.get::<Host>(&h.id).unwrap().label, "local");

        let mut newer = h.clone();
        newer.label = "newer".into();
        newer.updated_at = h.updated_at + 10;
        assert!(db.apply_remote(&newer).unwrap());
        let got = db.get::<Host>(&h.id).unwrap();
        assert_eq!(got.label, "newer");
        assert!(db.dirty::<Host>().unwrap().is_empty());
    }

    #[test]
    fn delete_group_reparents() {
        let db = Db::open_in_memory().unwrap();
        let mut parent = Group {
            id: new_id(),
            name: "p".into(),
            parent_id: None,
            icon: None,
            color: None,
            sort_order: 0,
            updated_at: 0,
            deleted_at: None,
        };
        db.save(&mut parent).unwrap();
        let mut child = Group {
            id: new_id(),
            name: "c".into(),
            parent_id: Some(parent.id.clone()),
            ..parent.clone()
        };
        db.save(&mut child).unwrap();
        let mut h = host("in-child");
        h.group_id = Some(child.id.clone());
        db.save(&mut h).unwrap();

        db.delete_group(&child.id).unwrap();
        assert_eq!(
            db.get::<Host>(&h.id).unwrap().group_id,
            Some(parent.id.clone())
        );
        assert!(db.get::<Group>(&child.id).is_err());
    }
}
