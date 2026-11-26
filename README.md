<p align="center">
  <img src="apps/desktop/public/logo.svg" alt="Termindo logo" width="128" height="128">
</p>

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

## Installers
The **Installers** workflow (`.github/workflows/bundle.yml`) builds `.deb`, `.rpm`,
AppImage (Linux), a universal `.dmg` (macOS, Apple Silicon + Intel) and `.msi` / NSIS
`.exe` (Windows):

- run it manually from the Actions tab (or `gh workflow run bundle.yml`) and download
  the installers from the run's artifacts;
- or push a version tag (`git tag v0.1.0 && git push origin v0.1.0`, matching `version`
  in `apps/desktop/src-tauri/tauri.conf.json`) to also get a draft GitHub release.

Installers are **not code-signed yet**: macOS needs right-click → Open (or
`xattr -dr com.apple.quarantine /Applications/Termindo.app`), and Windows SmartScreen
shows "More info → Run anyway".

Local build: `cd apps/desktop && npx tauri build` (output in `target/release/bundle/`).

### In-app updates
Windows, macOS and the Linux AppImage update themselves from **Settings → Updates** (or the
toast) with **Update & restart**. `.deb`/`.rpm` installs only get a notice and a link to
the release page. Nothing is installed until the user presses the button.

- Tag builds sign the updater bundles (`*.sig`) with a minisign key from the repository
  secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The
  matching public key is `plugins.updater.pubkey` in `tauri.conf.json`. Generate the pair
  once with `npx tauri signer generate -w ~/.tauri/termindo-updater.key`. **If the private
  key is lost, installed versions can no longer update in-app** and must be reinstalled by
  hand.
- The release job builds `latest.json` with `scripts/make-latest-json.mjs`. If a platform
  has no signature, the job fails. The app reads
  `releases/latest/download/latest.json`, so an update is visible only after the draft
  release is published.
- To test locally, build with a throwaway key:
  `TAURI_SIGNING_PRIVATE_KEY="$(cat test.key)" npx tauri build --config src-tauri/tauri.updater.conf.json`.

## Sync (private cloud)
Sync is optional and end-to-end encrypted. Run the sync server on your own VPS with
Docker (Postgres + server + Caddy HTTPS + daily backups): see
**[docs/deploy-vps.md](docs/deploy-vps.md)**. Client devices only need the installer.

- The server image is published publicly to `ghcr.io/bionyxxx/termindo-server` by the
  **Server image** workflow (no registry login needed). Tags: `latest` (master),
  `X.Y.Z` / `X.Y` (releases), `sha-<commit>`.
- Set the repository variable `TERMINDO_SYNC_URL` (e.g. `https://sync.example.com`) and
  release installers come preconfigured with that server.
- Protocol and crypto details: [docs/sync-protocol.md](docs/sync-protocol.md).

## Security
See [docs/security.md](docs/security.md).

## License
Copyright (C) 2026 Dutta Fachrezy

Termindo is free software, licensed under the
[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). It comes
with no warranty. If you distribute it, or let people use a modified version over a
network, you must offer them the corresponding source under the same license.

Third-party dependencies keep their own licenses.
