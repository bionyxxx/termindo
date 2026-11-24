# Security model

## Assets
- SSH passwords, private keys and key passphrases (the **secrets**)
- Host inventory, snippets, known host keys (sensitive metadata)
- The sync account

## Key hierarchy

```
master password ──Argon2id(salt, m=64 MiB, t=3, p=4)──▶ master key (MK, never stored)
  MK ──HKDF-SHA256 "termindo/enc/v1"──▶ KEK          wraps the DEK
  MK ──HKDF-SHA256 "termindo/auth/v1"─▶ auth key     proves the password to the sync server
DEK  (random 32 bytes)  encrypts every secret field and every sync record
recovery key (random 32 bytes, shown once)  also wraps the DEK
  recovery key ──HKDF "termindo/recovery-auth/v1"──▶ recovery auth key (server-side recovery)
```

- AEAD everywhere: **XChaCha20-Poly1305**, random 24-byte nonce per message,
  associated data binds ciphertext to its context (`record id`, `termindo/dek/v1`, …).
- Changing the master password only re-wraps the DEK (`crates/core/src/vault.rs`).
- The vault metadata (salt, KDF params, wrapped DEKs) is stored in the local SQLite
  database; the DEK only exists in memory while unlocked (`zeroize` on drop).
- Optional OS keychain unlock stores DEK + auth key in the platform keychain
  (macOS Keychain, Windows Credential Manager, Secret Service on Linux).

## Local storage
- `credentials.data_enc` = `XChaCha20-Poly1305(DEK, json(secret), aad = credential id)`.
- Non-secret data (hosts, groups, snippets, known hosts, history) is stored in plaintext
  SQLite in the app data directory. Use full-disk encryption if that matters to you.
- The sync refresh token is stored sealed with the DEK.
- Remote files opened for editing are written to `<data dir>/tmp/edit/<random>/` (0700) and
  deleted when the SFTP tab closes / the app restarts.

## Sync (zero knowledge)
See [sync-protocol.md](sync-protocol.md). The server stores:
- `argon2id(auth_hash)`, never the password or MK;
- KDF salt/params and the wrapped DEK (useless without the password);
- opaque record blobs `XChaCha20-Poly1305(DEK, {kind, data}, aad = "termindo/record/v1:" + id)`;
- record ids, timestamps and tombstone flags (metadata leak accepted).

A compromised server can delete or withhold data and see how many records you have and
when they change, but cannot read or undetectably modify them (AEAD + id binding).
It *can* replay an older ciphertext of the same record (rollback); last-write-wins
timestamps make that visible only partially. This is a known limitation.

## SSH
- Host keys: trust-on-first-use with a blocking confirmation dialog; a changed key shows a
  prominent warning with old/new fingerprints. Known hosts are synced.
- `russh` (pure Rust) with the `ring` crypto backend; keepalives every 30 s by default.
- Passwords typed in a prompt (not saved) live only in the renderer memory of that tab.

## Threats not covered
- Malware running as your user while the vault is unlocked.
- A malicious sync server serving you an old snapshot (rollback).
- Shoulder surfing of terminal content, clipboard managers capturing copied secrets.

## Reporting
Personal project for now: open an issue or contact the maintainer privately.
