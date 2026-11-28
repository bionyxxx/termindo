<p align="center">
  <img src="apps/desktop/public/logo.svg" alt="Logo Termindo" width="128" height="128">
</p>

# Termindo

Klien SSH desktop lintas platform: tab terminal dan split pane, pengelola host &
snippet, SFTP dengan transfer yang bisa dilanjutkan, serta sinkronisasi opsional
terenkripsi end-to-end ke server yang Anda hosting sendiri.

Dibangun dengan **Rust** (Tauri 2, russh, rusqlite, Axum) dan **React + TypeScript** (xterm.js).

## Fitur
- **Terminal SSH**: password, private key (dengan passphrase), ssh-agent, keyboard-interactive (2FA/OTP),
  rantai ProxyJump, verifikasi host key TOFU dengan peringatan saat berubah, keepalive,
  sambung ulang otomatis, xterm.js yang dirender dengan WebGL, dilengkapi pencarian, tema,
  salin/tempel, dan tautan yang bisa diklik.
- **Workspace**: tab (seret untuk mengubah urutan), split pane horizontal/vertikal, navigasi
  keyboard, broadcast input ke semua pane, pemulihan sesi saat aplikasi dibuka.
- **Host & snippet**: grup bertingkat, tag, pencarian, command palette (Ctrl+K), koneksi cepat
  `user@host:port`, impor `~/.ssh/config` (termasuk key), backup JSON/CSV, snippet dengan
  `{{placeholders}}` yang bisa dijalankan di satu atau banyak sesi, riwayat koneksi.
- **SFTP**: browser dua panel lokal/remote, drag & drop (juga dari file manager Anda),
  unggah/unduh file dan folder, antrean transfer dengan prioritas, jeda/lanjutkan/coba lagi,
  edit file remote di editor lokal (otomatis diunggah saat disimpan), chmod/ganti nama/hapus/buat baru.
- **Vault**: master password Argon2id, kredensial terenkripsi XChaCha20-Poly1305, recovery key,
  buka kunci lewat keychain OS (opsional), kunci otomatis, pembuatan key Ed25519.
- **Sinkronisasi** (opsional): sinkronisasi E2E terenkripsi zero-knowledge dengan pengelolaan
  banyak perangkat (`apps/server`, Docker compose di `deploy/`).

## Struktur repositori
```
crates/core      model data, SQLite, vault & kripto, impor ssh_config, backup
crates/ssh       koneksi/autentikasi russh, shell PTY, SFTP, pembuatan key
crates/sync      tipe protokol sinkronisasi, enkripsi record, klien + engine
apps/desktop     aplikasi Tauri (src-tauri = Rust, src = UI React)
apps/server      server sinkronisasi Axum + Postgres
deploy/          docker compose untuk self-hosting server sinkronisasi
docs/            arsitektur, model keamanan, protokol sinkronisasi
```

## Pengembangan

Prasyarat: Rust (stable, via rustup), Node.js ≥ 20, dan
[dependensi sistem Tauri](https://v2.tauri.app/start/prerequisites/)
(Linux: `webkit2gtk-4.1`, `libsoup3`, `gtk3`, ditambah `dbus` untuk keychain).

```bash
cd apps/desktop
npm install
npm run tauri dev          # jalankan aplikasi desktop dengan hot reload
npm run tauri build        # installer ada di target/release/bundle/
```

Pengujian:

```bash
cargo test --workspace                     # unit test (core, ssh, sync, server)
(cd apps/desktop && npm test)              # unit test frontend

# Integration test SSH terhadap server OpenSSH asli (Docker):
eval "$(scripts/test-sshd.sh)" && cargo test -p termindo-ssh --test openssh

# Integration test server:
docker run --rm -d --name termindo-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:17
TERMINDO_TEST_DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres cargo test -p termindo-server
```

Env var yang berguna untuk aplikasi desktop: `TERMINDO_DATA_DIR` (profil terpisah),
`TERMINDO_FAST_KDF=1` (khusus debug build: KDF ringan untuk pengujian), `RUST_LOG`.

## Installer
Workflow **Installers** (`.github/workflows/bundle.yml`) membuat `.deb`, `.rpm`,
AppImage (Linux), `.dmg` universal (macOS, Apple Silicon + Intel), serta `.msi` / NSIS
`.exe` (Windows):

- jalankan secara manual dari tab Actions (atau `gh workflow run bundle.yml`), lalu unduh
  installer dari artifacts hasil run tersebut;
- atau push tag versi (`git tag v0.1.0 && git push origin v0.1.0`, harus sama dengan `version`
  di `apps/desktop/src-tauri/tauri.conf.json`) agar sekaligus dibuatkan draft GitHub release.

Installer **belum ditandatangani (code signing)**: di macOS perlu klik kanan → Open (atau
`xattr -dr com.apple.quarantine /Applications/Termindo.app`), dan Windows SmartScreen
akan menampilkan "More info → Run anyway".

Build lokal: `cd apps/desktop && npx tauri build` (hasilnya di `target/release/bundle/`).

### Pembaruan dari dalam aplikasi
Windows, macOS, dan Linux AppImage dapat memperbarui diri dari **Settings → Updates** (atau
lewat toast) dengan tombol **Update & restart**. Instalasi `.deb`/`.rpm` hanya mendapat
pemberitahuan dan tautan ke halaman rilis. Tidak ada yang dipasang sebelum pengguna menekan
tombol tersebut.

- Build dari tag menandatangani bundle updater (`*.sig`) dengan key minisign dari repository
  secret `TAURI_SIGNING_PRIVATE_KEY` dan `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Public key
  pasangannya ada di `plugins.updater.pubkey` pada `tauri.conf.json`. Pasangan key cukup
  dibuat sekali dengan `npx tauri signer generate -w ~/.tauri/termindo-updater.key`. **Jika
  private key hilang, versi yang sudah terpasang tidak bisa lagi diperbarui dari dalam
  aplikasi** dan harus diinstal ulang secara manual.
- Job rilis membuat `latest.json` dengan `scripts/make-latest-json.mjs`. Jika ada platform
  yang tidak memiliki signature, job akan gagal. Aplikasi membaca
  `releases/latest/download/latest.json`, sehingga pembaruan baru terlihat setelah draft
  release dipublikasikan.
- Untuk menguji secara lokal, build dengan key sementara:
  `TAURI_SIGNING_PRIVATE_KEY="$(cat test.key)" npx tauri build --config src-tauri/tauri.updater.conf.json`.

## Sinkronisasi (private cloud)
Sinkronisasi bersifat opsional dan terenkripsi end-to-end. Jalankan server sinkronisasi di
VPS Anda sendiri dengan Docker (Postgres + server + Caddy HTTPS + backup harian): lihat
**[docs/deploy-vps.md](docs/deploy-vps.md)**. Perangkat klien hanya membutuhkan installer.

- Image server dipublikasikan secara publik ke `ghcr.io/bionyxxx/termindo-server` oleh
  workflow **Server image** (tidak perlu login ke registry). Tag: `latest` (master),
  `X.Y.Z` / `X.Y` (rilis), `sha-<commit>`.
- Atur repository variable `TERMINDO_SYNC_URL` (misalnya `https://sync.example.com`), maka
  installer rilis sudah terkonfigurasi dengan server tersebut.
- Detail protokol dan kripto: [docs/sync-protocol.md](docs/sync-protocol.md).

## Keamanan
Lihat [docs/security.md](docs/security.md).

## Lisensi
Copyright (C) 2026 Dutta Fachrezy

Termindo adalah perangkat lunak bebas, dilisensikan di bawah
[GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). Perangkat lunak
ini diberikan tanpa jaminan apa pun. Jika Anda mendistribusikannya, atau mengizinkan orang
lain menggunakan versi modifikasinya melalui jaringan, Anda wajib menyediakan kode sumber
yang sesuai kepada mereka di bawah lisensi yang sama.

Dependensi pihak ketiga tetap mengikuti lisensinya masing-masing.
