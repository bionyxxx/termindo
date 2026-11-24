# Termindo Sync Protocol

Termindo devices synchronise hosts, groups, credentials, snippets and known hosts
through a small HTTP server (`apps/server`). Sync is **end-to-end encrypted**:
the server stores ciphertext plus the minimum metadata needed to order and merge
changes. It never receives the master password, the master key, the data
encryption key (DEK) or any plaintext record.

Source of truth for the wire types: `crates/sync/src/protocol.rs`.
Record encryption: `crates/sync/src/envelope.rs`. Key hierarchy: `crates/core/src/vault.rs`.

---

## 1. Cryptography

### 1.1 Key hierarchy (client side)

```text
master password ──Argon2id(kdf_salt, kdf)──► master key (MK, 32 B)
   MK ──HKDF-SHA256 "termindo/enc/v1"──► KEK       wraps the DEK
   MK ──HKDF-SHA256 "termindo/auth/v1"──► auth key  proves the password to the server

DEK          random 32 B; encrypts every secret field and every sync record
recovery key random 32 B; shown once as a recovery kit (base32 groups)
   recovery key ──HKDF "termindo/recovery-auth/v1"──► recovery auth key
```

| Value | Algorithm | AAD |
|---|---|---|
| `wrapped_dek` | XChaCha20-Poly1305(KEK, DEK) | `termindo/dek/v1` |
| `wrapped_dek_recovery` | XChaCha20-Poly1305(recovery key, DEK) | `termindo/dek-recovery/v1` |
| record `blob` | XChaCha20-Poly1305(DEK, JSON payload) | `termindo/record/v1:<record id>` |

All sealed values are `nonce (24 B) ‖ ciphertext ‖ tag (16 B)`, base64 (standard alphabet) on the wire.
Default KDF parameters: Argon2id, 64 MiB, 3 passes, 4 lanes (`KdfParams::default()`).

### 1.2 What the server stores

| Data | Server can read? |
|---|---|
| email | yes (account identifier) |
| `auth_hash` (= auth key) | stored only as an **Argon2id PHC hash** |
| `recovery_auth_hash` | stored only as an Argon2id PHC hash |
| `kdf_salt`, `kdf` | yes (needed by new devices; not secret) |
| `wrapped_dek`, `wrapped_dek_recovery` | opaque ciphertext |
| record `id`, `updated_at`, `deleted`, `seq` | yes (sync metadata) |
| record `blob` | opaque ciphertext (entity kind is *inside* the blob) |

Binding the record id as AAD stops a malicious server from swapping ciphertexts
between records. A compromised server can still withhold, replay older versions
of, or delete records; it cannot read or forge them.

### 1.3 Changing the master password

The client derives a new MK with a fresh salt, re-wraps the **same** DEK, and calls
`POST /account/password`. No record is re-encrypted. All other devices are signed
out and must log in again with the new password.

---

## 2. HTTP API

Base path `/api/v1`. JSON bodies. Errors always have the shape:

```json
{ "error": "human readable message", "code": "machine_code" }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | validation failed |
| 401 | `unauthorized` | missing/invalid/expired access token |
| 401 | `device_revoked` | the device was signed out |
| 401 | `invalid_credentials` | wrong email or password |
| 401 | `invalid_recovery_key` | wrong email or recovery key |
| 403 | `registration_disabled` | `TERMINDO_ALLOW_REGISTRATION=false` |
| 404 | `not_found` | |
| 409 | `email_taken` | |
| 429 | `rate_limited` | more than 30 `/auth/*` requests per minute per IP |
| 500 | `internal` | |

`GET /health` (outside `/api/v1`) returns `{"status":"ok"}`.

### 2.1 Authentication

Access tokens are HS256 JWTs valid for **15 minutes** with claims
`{ sub: user_id, did: device_id, iat, exp }`, sent as `Authorization: Bearer <token>`.
Every authenticated request also checks that the device has not been revoked, so
revocation is immediate.

Refresh tokens are 32 random bytes (hex), valid for **60 days**, stored only as
SHA-256 hashes and bound to one device. Each refresh **rotates** the token.
Presenting an already-used refresh token is treated as theft: the whole device is
revoked.

| Method & path | Auth | Request | Response |
|---|---|---|---|
| `POST /auth/prelogin` | – | `PreloginRequest {email}` | `PreloginResponse {kdf_salt, kdf}` |
| `POST /auth/register` | – | `RegisterRequest {email, auth_hash, keys, recovery_auth_hash?, device_name}` | `AuthResponse` |
| `POST /auth/login` | – | `LoginRequest {email, auth_hash, device_name}` | `AuthResponse` |
| `POST /auth/refresh` | – | `RefreshRequest {refresh_token}` | `TokenResponse` |
| `POST /auth/logout` | ✓ | – | `{ok:true}` (revokes this device) |
| `POST /auth/recover/challenge` | – | `RecoverChallengeRequest {email, recovery_auth_hash}` | `{wrapped_dek_recovery}` |
| `POST /auth/recover` | – | `RecoverRequest {email, recovery_auth_hash, new_auth_hash, kdf_salt, kdf, wrapped_dek, device_name}` | `AuthResponse` (all other devices revoked) |
| `GET /account/keys` | ✓ | – | `AccountKeys` |
| `POST /account/password` | ✓ | `ChangePasswordRequest {current_auth_hash, new_auth_hash, kdf_salt, kdf, wrapped_dek}` | `{ok:true}` (other devices revoked) |
| `GET /devices` | ✓ | – | `Device[]` (active devices, `current` marks the caller) |
| `DELETE /devices/{id}` | ✓ | – | `{ok:true}` |

`prelogin` for an unknown email returns a **deterministic fake salt**
(`HMAC-SHA256(server secret, "termindo/fake-salt/v1:" + email)[..16]`) and the
default KDF parameters, so the endpoint cannot be used to enumerate accounts.
Login for unknown emails also verifies against a dummy Argon2 hash to keep timing
uniform. Emails are trimmed and lower-cased.

#### Login flow on a new device

1. `prelogin(email)` → `kdf_salt`, `kdf`
2. MK = Argon2id(password, kdf_salt, kdf); auth key = HKDF(MK, "termindo/auth/v1")
3. `login(email, base64(auth key))` → tokens + `keys`
4. KEK = HKDF(MK, "termindo/enc/v1"); DEK = open(KEK, `keys.wrapped_dek`)
5. Store the vault metadata locally and pull everything (cursor 0).

#### Recovery flow

1. recovery auth = HKDF(recovery key, "termindo/recovery-auth/v1")
2. `recover/challenge` → `wrapped_dek_recovery`; DEK = open(recovery key, …)
3. Choose a new password, re-wrap the DEK, `recover` with the new material.

### 2.2 Sync

| Method & path | Request | Response |
|---|---|---|
| `GET /sync?since=<cursor>&limit=<n>` | – | `PullResponse {records: RemoteRecord[], cursor, has_more}` |
| `POST /sync` | `PushRequest {records: PushRecord[]}` | `PushResponse {accepted: id[], rejected: id[]}` |

* `limit` is clamped to 1..=1000 (default 500).
* A push holds at most `MAX_PUSH` (500) records; each blob at most `MAX_BLOB_LEN`
  (256 KiB of base64). Request bodies may be up to 64 MiB.

#### Records

```text
RemoteRecord { id, seq, updated_at, deleted, blob }
PushRecord   { id, updated_at, deleted, blob }
blob = base64(seal(DEK, {"kind": "host" | "group" | "credential" | "snippet" | "known_host", "data": {...}},
                   aad = "termindo/record/v1:" + id))
```

`updated_at` is the client's modification time in Unix **milliseconds** and is
the only ordering key used for conflict resolution. `deleted` mirrors the
record's tombstone (`deletedAt` inside the payload).

#### Cursor (`seq`)

Every stored change receives a new value from a global, strictly increasing
sequence. Pull returns records of the caller's account with `seq > since` in
ascending `seq` order; the response `cursor` is the last `seq` returned (or
`since` if none). A record that changes again moves to the end of the log, so the
server keeps only the latest version of each record.

Pushes for one account are serialised with a transaction-scoped advisory lock,
which guarantees `seq` values become visible in increasing order per account: a
client that stores the cursor after each page can never skip a change.

#### Conflict resolution: last-write-wins per record

For each pushed record the server calls `decide_push(incoming.updated_at, existing.updated_at)`:

| Condition | Decision | Effect |
|---|---|---|
| no existing record, or incoming newer | `Store` | upsert, new `seq`; id in `accepted` |
| same `updated_at` | `AlreadyStored` | no change (idempotent retry); id in `accepted` |
| existing newer | `Reject` | id in `rejected`; the client receives the newer version on its next pull |

The client applies pulled records with the same rule (`Db::apply_remote`): a
remote record replaces the local copy only if its `updated_at` is newer; an equal
version just clears the local dirty flag.

#### Tombstones

Deletes are soft: the record is pushed with `deleted: true` and a payload whose
`deletedAt` is set. Tombstones take part in LWW like any other version, so a
delete on one device and an older edit on another converge to "deleted". The
server keeps tombstones indefinitely.

#### Client sync cycle (`crates/sync/src/engine.rs`)

1. **Push** every locally dirty record (batches of `MAX_PUSH`); clear the dirty
   flag of accepted ids whose `updated_at` didn't change meanwhile.
2. **Pull** from the stored cursor until `has_more` is false, decrypt, apply with
   LWW, and persist the cursor after each page.

Records that fail to decrypt (e.g. pushed with another account's DEK) are skipped
and reported, never applied.

---

## 3. Self-hosting

Requirements: Docker with Compose v2.

```sh
cd deploy
cp .env.example .env
# edit .env: TERMINDO_JWT_SECRET (openssl rand -base64 48) and POSTGRES_PASSWORD
docker compose up -d --build            # server on http://<host>:8080
docker compose --profile tls up -d --build   # adds Caddy with automatic HTTPS
```

For the `tls` profile set `TERMINDO_DOMAIN` (DNS must point at the host, ports
80/443 open) and `TERMINDO_TRUST_PROXY=true` so rate limiting sees real client
IPs. Without the profile, put the server behind your own TLS-terminating proxy —
**never expose plain HTTP sync over the internet**: although records are
end-to-end encrypted, the `auth_hash` and tokens travel in requests.

Server configuration (environment):

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | – (required) | PostgreSQL URL |
| `TERMINDO_JWT_SECRET` | – (required, ≥ 32 chars) | signs access tokens; also keys the fake-salt HMAC |
| `TERMINDO_BIND` | `0.0.0.0:8080` | listen address |
| `TERMINDO_ALLOW_REGISTRATION` | `true` | set `false` once your account exists |
| `TERMINDO_TRUST_PROXY` | `false` | use `X-Forwarded-For` for rate limiting |
| `RUST_LOG` | `info` | log filter |

Migrations run automatically at startup. Rotating `TERMINDO_JWT_SECRET` signs
everyone out of their access tokens (refresh tokens keep working) and changes
the fake salts returned for unknown emails.

Backups: `docker compose exec postgres pg_dump -U termindo termindo > backup.sql`.
The dump contains only ciphertext and hashes, but treat it as sensitive anyway.

### Running the server tests

```sh
docker run --rm -d --name termindo-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17
TERMINDO_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres cargo test -p termindo-server
docker stop termindo-pg
```

Without `TERMINDO_TEST_DATABASE_URL` the API tests are skipped (unit tests still run).
