# Termindo

A cross-platform desktop SSH client: terminal tabs and split panes, host & snippet
manager, SFTP with resumable transfers, and optional end-to-end encrypted sync to a
server you host yourself.

Built with **Rust** (Tauri 2, russh, rusqlite, Axum) and **React + TypeScript** (xterm.js).

## Features
- **SSH terminal**: password, private key (with passphrase), ssh-agent, keyboard-interactive (2FA/OTP),
  ProxyJump chains, TOFU host key verification with change warnings, keepalive, auto-reconnect,
  WebGL-rendered xterm.js with search, themes, copy/paste, clickable links.
- **Workspace**: tabs (drag to reorder), split panes horizontally/vertically, keyboard navigation,
  broadcast input to all panes, session restore on startup.
- **Hosts & snippets**: nested groups, tags, search, command palette (Ctrl+K), quick connect
  `user@host:port`, import `~/.ssh/config` (keys included), JSON/CSV backup, snippets with
  `{{placeholders}}` run on one/many sessions, connection history.
- **SFTP**: dual pane local/remote browser, drag & drop (also from your file manager),
  upload/download files and folders, transfer queue with priority, pause/resume/retry,
  edit remote files in your local editor (auto-upload on save), chmod/rename/delete/new.
- **Vault**: Argon2id master password, XChaCha20-Poly1305 encrypted credentials, recovery key,
  optional OS keychain unlock, auto-lock, Ed25519 key generation.
- **Sync** (optional): zero-knowledge E2E encrypted sync with multi-device management
  (`apps/server`, Docker compose in `deploy/`).

## Repository layout
```
crates/core      data model, SQLite, vault & crypto, ssh_config import, backups
crates/ssh       russh connection/auth, PTY shells, SFTP, key generation
crates/sync      sync protocol types, record encryption, client + engine
apps/desktop     Tauri app (src-tauri = Rust, src = React UI)
apps/server      Axum + Postgres sync server
deploy/          docker compose for self-hosting the sync server
docs/            architecture, security model, sync protocol
```

## Development

Prerequisites: Rust (stable, via rustup), Node.js ≥ 20, and the
[Tauri system dependencies](https://v2.tauri.app/start/prerequisites/)
(Linux: `webkit2gtk-4.1`, `libsoup3`, `gtk3`, plus `dbus` for the keychain).

```bash
cd apps/desktop
npm install
npm run tauri dev          # run the desktop app with hot reload
npm run tauri build        # installers in target/release/bundle/
```

Tests:

```bash
cargo test --workspace                     # unit tests (core, ssh, sync, server)
(cd apps/desktop && npm test)              # frontend unit tests

# SSH integration tests against a real OpenSSH server (Docker):
eval "$(scripts/test-sshd.sh)" && cargo test -p termindo-ssh --test openssh

# Server integration tests:
docker run --rm -d --name termindo-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:17
TERMINDO_TEST_DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres cargo test -p termindo-server
```

Useful env vars for the desktop app: `TERMINDO_DATA_DIR` (separate profile),
`TERMINDO_FAST_KDF=1` (debug builds only: cheap KDF for testing), `RUST_LOG`.

## Self-hosting sync
See [docs/sync-protocol.md](docs/sync-protocol.md) and `deploy/docker-compose.yml`:

```bash
cd deploy
cp .env.example .env   # set TERMINDO_JWT_SECRET and POSTGRES_PASSWORD
docker compose up -d   # server on :8080 (add --profile tls for Caddy + HTTPS)
```

Then in Termindo: Settings → Sync account → server URL → Create account.

## Security
See [docs/security.md](docs/security.md).

## License
Not chosen yet (all rights reserved until a license is added).
