# PLAN.md — Termindo

> Aplikasi SSH client desktop setara Termius.
> Status: **Implementasi awal F1–F5 selesai, build & test lulus** (lihat §9).
> Terakhir diperbarui: 2026-11-24

---

## 1. Ringkasan Proyek

**Termindo** adalah aplikasi desktop cross-platform (Windows, macOS, Linux) untuk mengelola
koneksi SSH ke banyak server, dengan fitur utama:

1. **Terminal SSH interaktif** — koneksi password / private key / agent, terminal emulator penuh.
2. **Multi-tab & split terminal** — banyak sesi sekaligus, split pane horizontal/vertikal, layout tersimpan.
3. **Manajemen host & snippet** — grup, tag, pencarian, import/export OpenSSH config, snippet perintah.
4. **SFTP / file transfer** — browse file remote, upload/download dengan progress & resume, edit file remote.
5. **Cloud sync & akun** — sinkronisasi antar device dengan enkripsi end-to-end, offline-first.

**Keputusan yang sudah diambil:**

| Aspek | Keputusan |
|---|---|
| Platform | Desktop saja (Windows/macOS/Linux) |
| Bahasa utama | Rust |
| Fitur MVP | 5 fitur di atas (port forwarding menyusul pasca-MVP) |
| Penyimpanan | Lokal (SQLite + vault terenkripsi) **dan** cloud sync |
| Port forwarding | Bukan MVP, tapi arsitektur mendukung penambahan di fase lanjutan |

---

## 2. Stack Teknologi

### 2.1 Aplikasi Desktop

| Layer | Teknologi | Alasan |
|---|---|---|
| Shell aplikasi | **Tauri 2** | Cross-platform, binary kecil (~10 MB), inti Rust, IPC type-safe |
| Terminal emulator | **xterm.js** (+ WebGL renderer, fit addon, search addon) | Standar de-facto (dipakai VS Code): Unicode, IME, scrollback, selection, ligatures matang |
| UI frontend | **React + TypeScript + Vite** | Ekosistem komponen tab/panel/tree yang kuat |
| Styling | **TailwindCSS + Radix UI** | UI cepat & konsisten |
| Split pane | `react-resizable-panels` | Split horizontal/vertikal yang fleksibel |
| State management | **Zustand** + **TanStack Query** | Sederhana, cocok untuk state UI + data async |
| SSH client | **`russh`** (pure Rust, async/tokio) | Tanpa binding C; dukung password, publickey, keyboard-interactive |
| SFTP | **`russh-sftp`** | Satu koneksi dengan sesi SSH |
| Data lokal | **SQLite** (`rusqlite` atau `sqlx`) | Host, grup, snippet, riwayat |
| Vault kredensial | **OS keychain** (`keyring`) + **Argon2id** + **XChaCha20-Poly1305** | Master password → key derivasi → enkripsi kredensial |
| PTY lokal (opsional) | `portable-pty` | Untuk fitur local terminal di masa depan |
| Observability | `tracing` + `tracing-subscriber` | Logging terstruktur |

### 2.2 Backend Cloud Sync

| Layer | Teknologi | Alasan |
|---|---|---|
| Framework | **Axum** (Rust) | Konsisten satu bahasa dengan aplikasi |
| Database | **PostgreSQL** + `sqlx` | Andal untuk sinkronisasi |
| Autentikasi | JWT (`jsonwebtoken`) + refresh token + **Argon2id** | Model token ganda seperti layanan modern |
| Enkripsi E2E | `chacha20poly1305`, `ed25519-dalek`, `x25519-dalek` | Server hanya menyimpan blob terenkripsi |
| Deployment | Docker + reverse proxy (Caddy/Traefik) | |

### 2.3 Testing & CI/CD

- **Rust:** `cargo test`, `clippy`, `rustfmt`
- **Frontend:** Vitest (unit), Playwright (e2e UI)
- **Integrasi SSH:** test terhadap OpenSSH server di Docker (testcontainers)
- **CI:** GitHub Actions — lint + test + build matrix (Windows/macOS/Linux)
- **Distribusi:** Tauri bundler (MSI/NSIS, DMG, AppImage/deb/rpm) + Tauri Updater (auto-update)

### 2.4 Alternatif yang dipertimbangkan

| Alternatif | Konsekuensi |
|---|---|
| **100% Rust** (egui/iced + `alacritty_terminal`) | Tanpa TS sama sekali, tapi harus menulis rendering teks GPU, IME, selection sendiri → jauh lebih banyak pekerjaan untuk hasil yang sama |
| **Leptos/WASM di dalam Tauri** | Bahasa tetap Rust, tapi interop ke xterm.js lebih gesekan, ekosistem lebih muda |
| `ssh2` (libssh2 binding) | Matang tapi blocking & butuh C toolchain; `russh` dipilih karena pure Rust + async |

---

## 3. Arsitektur

### 3.1 Struktur Workspace (Rust workspace monorepo)

```
termindo/
├── PLAN.md
├── Cargo.toml               # workspace root
├── crates/
│   ├── core/                # model data, vault, kripto, config, error types
│   ├── ssh/                 # koneksi russh, autentikasi, channel, SFTP, port forward (nanti)
│   └── sync/                # protokol sync, konflik resolution, enkripsi payload
├── apps/
│   ├── desktop/             # Tauri app
│   │   ├── src-tauri/       # Rust: commands, state, tray, updater
│   │   └── src/             # React + TS frontend
│   └── server/              # Axum sync server
├── docs/
│   ├── architecture.md
│   ├── sync-protocol.md     # rancangan protokol sync & kriptografi
│   └── security.md          # model ancaman, pengelolaan kunci
└── .github/workflows/       # CI
```

### 3.2 Alur data terminal

```
xterm.js (webview)  ←IPC bytes→  Tauri command/event  ←tokio→  russh channel (PTY remote)
```

- Frontend hanya merender byte terminal; Tauri Rust memegang koneksi SSH.
- Event stream Tauri (channel) untuk output, command untuk input & resize (window-change).

### 3.3 Skema database lokal (SQLite, ringkas)

| Tabel | Kolom kunci |
|---|---|
| `groups` | id, name, parent_id, icon, color |
| `hosts` | id, group_id, label, hostname, port, username, auth_type, credential_id, jump_host_id, options(json), updated_at, deleted_at |
| `credentials` | id, label, kind (password/key), data_enc (blob terenkripsi), updated_at, deleted_at |
| `keypairs` | id, label, public_key, private_key_enc, passphrase_enc |
| `snippets` | id, name, body, placeholders(json), hotkey, updated_at, deleted_at |
| `known_hosts` | host, port, host_key_type, host_key |
| `sync_meta` | entity, last_synced_at, cursor |

Prinsip: **offline-first** — semua operasi terhadap SQLite lokal, sync berjalan di background.

### 3.4 Model sync & enkripsi E2E (ringkas)

1. Master password → **Argon2id** → master key (tidak pernah dikirim ke server).
2. Master key membungkus *data encryption key* (DEK); DEK mengenkripsi setiap record
   dengan **XChaCha20-Poly1305** (nonce acak per record).
3. Server menyimpan blob terenkripsi + metadata minimum (id, updated_at, revision, tombstone).
4. Sync: pull delta sejak cursor → dekripsi lokal → merge; push perubahan lokal.
5. Konflik: **last-write-wins per record** berbasis `updated_at` + revision, dengan
   pertimbangan CRDT untuk fase lanjutan. Delete = tombstone (soft delete) untuk anti-konflik.
6. Ganti master password = re-encryption DEK saja (bukan seluruh record).
7. Recovery code (recovery kit) dicetak/di-simpan user saat registrasi.

---

## 4. Detail Fitur MVP

### F1. Terminal SSH interaktif
- Koneksi: password, private key (dengan/passphrase), keyboard-interactive.
- Verifikasi host key (TOFU + dialog peringatan saat key berubah).
- Keepalive & auto-reconnect, resize terminal otomatis (window-change).
- Copy/paste, search di scrollback, tema terang/gelap, font setting.

### F2. Multi-tab & split terminal
- Tab bar + split horizontal/vertikal, fokus & navigasi via keyboard shortcut.
- Layout tersimpan per host/group, restore sesi terakhir (opsional).
- Drag & drop tab, indicator status koneksi per tab.

### F3. Manajemen host & snippet
- CRUD host, grup berjenjang, tag & pencarian cepat (command palette).
- Import/export: OpenSSH `~/.ssh/config`, CSV/JSON backup.
- Snippet dengan placeholder (`{{host}}`, `{{port}}`, dsb.), jalankan ke banyak sesi.
- Riwayat koneksi & statistik sederhana.

### F4. SFTP / file transfer
- File tree remote (navigate, breadcrumb, search).
- Upload/download multi-file + folder, progress, pause/resume, retry.
- Edit file remote langsung (buka di editor lokal → save → upload kembali).
- Ubah permission (chmod), rename, delete, buat folder/file baru.
- Transfer queue dengan prioritas.

### F5. Cloud sync & akun
- Registrasi/login, device management (lihat & revoke device).
- Sync otomatis terenkripsi E2E, indikator status sync.
- Offline penuh; konflik resolved secara deterministic.
- Opsional: self-host server (Docker image disediakan).

---

## 5. Roadmap / Fase

| Fase | Isi |
|---|---|
| **F1 — Fondasi** | Workspace repo, shell Tauri, skema SQLite, vault + master password, CI dasar |
| **F2 — SSH core** | Koneksi `russh`, auth password & key, terminal tab pertama (xterm.js ↔ channel) |
| **F3 — Workspace UX** | Multi-tab, split pane, host manager, snippets, import OpenSSH |
| **F4 — SFTP** | File browser, transfer dengan progress/resume, edit remote |
| **F5 — Sync & akun** | Axum server, JWT auth, E2E encrypted sync, device management |
| **F6 — Polish & rilis** | Known-hosts UI, ProxyJump, port forwarding (opsional), packaging, auto-update |

---

## 6. Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| WebView berbeda per OS (WebView2/WKWebView/WebKitGTK) | Render terminal tidak konsisten | Deteksi renderer: WebGL → fallback canvas xterm.js; QA lintas OS sejak awal |
| Edge-case SSH (keyboard-interactive, key passphrase, host key rotation, ProxyJump) | Koneksi gagal di kasus nyata | Test suite terhadap OpenSSH server Docker sejak F2 |
| Desain kripto sync salah | Kebocoran data kredensial | Rancang `docs/security.md` sebelum F5, review kripto independen, jangan pernah kirim kunci ke server |
| Transfer file besar | Memory/OOM, gagal di tengah | Chunked streaming + resume + checksum verifikasi |
| Kompleksitas konflik sync | Data hilang/tertimpa | LWW deterministik + tombstone dulu; CRDT hanya jika terbukti perlu |
| Scope creep (Terminal UI mewah) | Rilis tertunda | Kunci lingkup MVP per fase; port forwarding & fitur lain di backlog |

---

## 7. Keputusan yang masih terbuka

- [x] Frontend: **React + TS** (xterm.js, Tailwind 4, Radix, zustand).
- [x] SQLite driver: **`rusqlite`** (bundled) di desktop; `sqlx` + Postgres di server.
- [ ] Nama final produk & bundle identifier.
- [ ] Kebijakan akun: wajib login untuk sync vs mode lokal-tanpa-akun (saat ini: keduanya didukung).
- [ ] Target minimum OS (mis. Windows 10+, macOS 12+, Ubuntu 22.04+).

---

## 8. Referensi

- Tauri 2: <https://tauri.app>
- xterm.js: <https://xtermjs.org>
- russh (SSH client pure Rust): <https://crates.io/crates/russh>
- Model keamanan serupa: Bitwarden security whitepaper (zero-knowledge), Termius vault.

---

## 9. Status implementasi (2026-11-24)

| Fase | Status | Catatan |
|---|---|---|
| F1 Fondasi | ✅ ditulis | Workspace, Tauri shell, skema SQLite + migrasi, vault (Argon2id/HKDF/XChaCha20-Poly1305), recovery key, OS keychain unlock, CI |
| F2 SSH core | ✅ ditulis | russh 0.65: password, key (+passphrase), agent, keyboard-interactive, ProxyJump; TOFU host key; PTY shell; xterm.js via raw IPC channel |
| F3 Workspace UX | ✅ ditulis | Tabs (drag), split pane, broadcast input, restore sesi, host/grup/tag, command palette, snippet + placeholder, import ~/.ssh/config, JSON/CSV backup, riwayat |
| F4 SFTP | ✅ ditulis | Dual pane, drag & drop (termasuk dari file manager), queue + prioritas, pause/resume/retry, edit remote, chmod/rename/delete |
| F5 Sync & akun | ✅ ditulis | Server Axum + Postgres, JWT + refresh rotation, E2E record envelope, LWW + tombstone, device management, recovery |
| F6 Polish & rilis | ⏳ | Port forwarding, updater, signing, QA lintas OS |

**Penyimpangan dari rencana awal:**
- Tabel `keypairs` digabung ke `credentials` (kind `private_key` + kolom `public_key`).
- TanStack Query tidak dipakai; zustand cukup untuk data lokal.
- Password akun sync = master password (model Bitwarden): server hanya menerima `auth_hash` turunan HKDF.
- `known_hosts.id` deterministik (`kh:<host>:<port>`) supaya device konvergen.
- Konflik LWW berbasis `updated_at`; versi sama = idempotent (tidak ada tie-break konten).

**Verifikasi (2026-11-24):**
- `cargo build` + `cargo clippy --workspace --all-targets -D warnings` + `cargo fmt`: bersih.
- `cargo test --workspace`: semua lulus, termasuk integrasi SSH terhadap OpenSSH di Docker
  (password, public key, password salah, PTY resize, exit status, SFTP resume dua arah, chmod/rename/hapus rekursif)
  dan integrasi server terhadap Postgres (register/login/push/pull/konflik/revoke/refresh reuse/ganti password/recovery).
- Frontend: `tsc`, `vitest`, `vite build` lulus; 73 command IPC dicek cocok nama & argumennya dengan Rust.
- App desktop jalan (`npm run tauri dev`): migrasi DB OK, tanpa panic.
- **Belum diuji:** alur UI di dalam jendela (klik-klik) — butuh uji manual atau `webkit2gtk-driver` untuk e2e.
