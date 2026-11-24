# Architecture

```
┌──────────────── apps/desktop (Tauri 2) ─────────────────┐
│ React + TS UI (src/)                                     │
│   xterm.js terminals ◀── raw bytes (ipc Channel) ──┐     │
│   zustand stores, Radix dialogs, Tailwind           │     │
│        │ invoke()                    events ▲       │     │
│ Rust commands (src-tauri/src/commands/*)    │       │     │
│   AppState: Db (SQLite), unlocked keys, sessions,   │     │
│   SFTP sessions, transfer queue, sync loop          │     │
└────────┬───────────────┬───────────────┬────────────┘     │
         │               │               │                  │
  crates/core      crates/ssh       crates/sync             │
  models, SQLite   russh client,    protocol types,          │
  vault crypto,    PTY shell ───────┘ envelope crypto,       │
  ssh_config,      SFTP, keys        HTTP client + engine ──▶ apps/server (Axum + Postgres)
  backups
```

## Crates
| Crate | Responsibility |
|---|---|
| `termindo-core` | Data model (`Entity` trait), SQLite schema + migrations, vault (Argon2id / HKDF / XChaCha20-Poly1305), OpenSSH config import/export, JSON/CSV backups, snippet placeholders |
| `termindo-ssh` | Connect + authenticate (password, key, agent, keyboard-interactive, ProxyJump chains), host key callback, PTY shell with split read/write halves, SFTP (list, ops, resumable up/download), key generation |
| `termindo-sync` | Wire protocol shared with the server, record envelope encryption, HTTP client with token refresh, push/pull/LWW engine |
| `termindo-server` | Axum sync server: auth, devices, encrypted record store |
| `termindo-desktop` | Tauri app: commands, state, background sync, transfer queue, UI |

## Data flow: terminal
1. UI creates a `Channel<ArrayBuffer>` and calls `ssh_connect(sessionId, target, cols, rows, channel)`.
2. Backend resolves the host, decrypts the credential, connects (host key / keyboard-interactive
   prompts go to the UI through the `prompt` event and `prompt_respond` command).
3. A PTY shell is opened; output chunks are coalesced and sent as raw bytes through the channel.
4. Keystrokes: `ssh_write`; resize: `ssh_resize` (→ SSH `window-change`).
5. Shell exit emits `ssh-closed`; the UI offers reconnect or auto-reconnects (host option).

## Offline-first sync
Every UI mutation writes SQLite and marks the row `dirty`, then nudges the background sync
loop (debounced 2 s, plus a periodic pull every 60 s). A sync cycle pushes dirty rows
(encrypted), clears `dirty` only if the row wasn't modified meanwhile, then pulls everything
after the stored cursor and applies it with last-write-wins on `updated_at`. Deletes are
tombstones.

## Persistence locations
- Desktop data: OS app data dir (`~/.local/share/dev.termindo.app` on Linux) — override with
  `TERMINDO_DATA_DIR`.
- UI settings and last session layout: `settings` table (`ui.*` keys).
