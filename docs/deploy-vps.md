# Menjalankan server sync di VPS

Panduan ini menyiapkan "cloud pribadi" Termindo: satu VPS menjalankan server sync, dan
semua perangkatmu menyinkronkan host, key, snippet, dan known hosts lewat server itu.

- **Perangkat pengguna tidak perlu Docker.** Cukup install Termindo dari GitHub Release.
- **Hanya VPS yang menjalankan Docker:** Postgres, server sync, Caddy (HTTPS otomatis),
  dan backup harian.
- Server hanya menyimpan data terenkripsi (end-to-end); lihat [security.md](security.md).

## Yang dibutuhkan

| Item | Catatan |
|---|---|
| VPS | Ubuntu 22.04/24.04, 1 vCPU, 1 GB RAM sudah cukup, disk 10 GB+ |
| Domain/subdomain | Misalnya `sync.domainmu.com` |

## 1. DNS
Buat record **A** `sync.domainmu.com` yang mengarah ke IP publik VPS (dan **AAAA**
kalau VPS punya IPv6). Tunggu sampai `dig +short sync.domainmu.com` menampilkan IP VPS.

## 2. Siapkan VPS
```bash
ssh root@IP_VPS

# Firewall: hanya SSH, HTTP (untuk sertifikat), dan HTTPS
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# Docker (skrip resmi)
curl -fsSL https://get.docker.com | sh
```

## 3. Salin konfigurasi
Image server dibangun oleh workflow **Server image** dan dipublikasikan secara publik di
`ghcr.io/bionyxxx/termindo-server`, jadi VPS tidak perlu `docker login`.

Ambil folder `deploy/` dari repo, langsung di VPS:
```bash
git clone --depth 1 https://github.com/bionyxxx/termindo.git /tmp/termindo
mkdir -p /opt/termindo && cp -r /tmp/termindo/deploy/. /opt/termindo/ && rm -rf /tmp/termindo
```
Atau dari laptop (di folder repo):
```bash
rsync -av --exclude backups/ deploy/ root@IP_VPS:/opt/termindo/
```

## 4. Isi `.env`
Di VPS:
```bash
cd /opt/termindo
cp .env.example .env
nano .env
#   TERMINDO_DOMAIN=sync.domainmu.com
#   TERMINDO_JWT_SECRET=<hasil: openssl rand -base64 48>
#   POSTGRES_PASSWORD=<hasil: openssl rand -base64 24>
```

## 5. Jalankan
```bash
docker compose --profile tls up -d
docker compose --profile tls ps
curl https://sync.domainmu.com/health      # harus: {"status":"ok"}
```
Caddy mengambil sertifikat Let's Encrypt otomatis pada request pertama. Kalau gagal,
cek `docker compose logs caddy` (biasanya DNS belum mengarah, atau port 80/443 tertutup).

## 6. Buat akun dari aplikasi
1. Buka Termindo → buat vault (atau unlock).
2. **Settings → Sync account**: server `https://sync.domainmu.com`, email, master
   password (sekaligus password akun) → **Create account**.
3. Di perangkat lain: layar awal → **I already have a sync account**.

## 7. Tutup pendaftaran
Setelah semua akunmu dibuat:
```bash
sed -i 's/^TERMINDO_ALLOW_REGISTRATION=.*/TERMINDO_ALLOW_REGISTRATION=false/' .env
docker compose --profile tls up -d
```

## 8. URL server bawaan di installer
Supaya installer berikutnya langsung terisi alamat server, set variabel repo:
```bash
gh variable set TERMINDO_SYNC_URL --body https://sync.domainmu.com
```
Lalu buat rilis baru (`git tag vX.Y.Z && git push origin vX.Y.Z`).

## Perawatan

**Update server** (setelah ada perubahan di `master` atau rilis baru):
```bash
cd /opt/termindo && ./update.sh
```
Untuk mengunci versi, set `TERMINDO_IMAGE` di `.env`, misalnya
`ghcr.io/bionyxxx/termindo-server:0.1` (seri rilis) atau `...:sha-2baa68c` (commit tertentu).

**Backup** dibuat harian di `/opt/termindo/backups` (simpan 7 harian, 4 mingguan,
6 bulanan). Salin juga ke luar VPS secara berkala, misalnya:
```bash
rsync -av root@IP_VPS:/opt/termindo/backups/ ~/termindo-backups/
```

**Restore** dari dump (database dikosongkan dulu, lalu diisi dari dump):
```bash
cd /opt/termindo
docker compose --profile tls stop server
docker compose exec -T postgres psql -U termindo -d termindo \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
gunzip -c backups/last/termindo-latest.sql.gz | \
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U termindo -d termindo
docker compose --profile tls start server
```
Ganti `backups/last/termindo-latest.sql.gz` dengan file lain di `daily/`, `weekly/`, atau
`monthly/` untuk kembali ke titik waktu tertentu.

**Log:** `docker compose logs -f server` / `docker compose logs -f caddy`.

## Tanpa domain?
Bisa sementara memakai tunnel (misalnya Cloudflare Tunnel atau Tailscale) ke
`127.0.0.1:8080`. Jangan membuka port 8080 langsung ke internet: tanpa HTTPS, token
login bisa disadap (isi data tetap terenkripsi).
