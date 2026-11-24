//! Cryptographic primitives used by the vault and the sync protocol.
//!
//! * Key derivation: Argon2id (master password -> master key)
//! * Sub-keys: HKDF-SHA256 (master key -> encryption key / auth key)
//! * AEAD: XChaCha20-Poly1305 with a random 24-byte nonce per message
//!
//! Sealed messages are encoded as `nonce (24 bytes) || ciphertext+tag`.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::{Error, Result};

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;
pub const SALT_LEN: usize = 16;

/// A 32-byte secret key that is wiped from memory on drop.
pub type SecretKey = Zeroizing<[u8; KEY_LEN]>;

/// Argon2id cost parameters. Stored alongside the salt so they can be raised later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub m_cost: u32,
    /// Iterations.
    pub t_cost: u32,
    /// Parallelism.
    pub p_cost: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        // 64 MiB, 3 passes, 4 lanes: ~0.3-0.6 s on a modern desktop.
        Self {
            m_cost: 64 * 1024,
            t_cost: 3,
            p_cost: 4,
        }
    }
}

impl KdfParams {
    /// Cheap parameters for unit tests only.
    pub fn insecure_for_tests() -> Self {
        Self {
            m_cost: 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.m_cost < 1024 || self.t_cost < 1 || self.p_cost < 1 || self.m_cost > 4 * 1024 * 1024
        {
            return Err(Error::Invalid("unsupported KDF parameters".into()));
        }
        Ok(())
    }
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf
}

pub fn random_key() -> SecretKey {
    Zeroizing::new(random_bytes::<KEY_LEN>())
}

/// Derive the master key from a password with Argon2id.
pub fn derive_master_key(password: &str, salt: &[u8], params: &KdfParams) -> Result<SecretKey> {
    params.validate()?;
    let p = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(KEY_LEN))
        .map_err(|e| Error::Crypto(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| Error::Crypto(e.to_string()))?;
    Ok(out)
}

/// Derive a purpose-bound sub-key from a master key with HKDF-SHA256.
pub fn derive_subkey(master: &[u8], info: &str) -> SecretKey {
    let hk = Hkdf::<Sha256>::new(None, master);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    hk.expand(info.as_bytes(), out.as_mut())
        .expect("32 bytes is a valid HKDF output length");
    out
}

/// Encrypt `plaintext` with XChaCha20-Poly1305. `aad` binds the ciphertext to a context.
pub fn seal(key: &[u8; KEY_LEN], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce_bytes = random_bytes::<NONCE_LEN>();
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| Error::Crypto("encryption failed".into()))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypt data produced by [`seal`].
pub fn open(key: &[u8; KEY_LEN], sealed: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if sealed.len() < NONCE_LEN + 16 {
        return Err(Error::Crypto("ciphertext too short".into()));
    }
    let (nonce, ct) = sealed.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| Error::Crypto("decryption failed (wrong key or tampered data)".into()))
}

pub fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

pub fn unb64(s: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| Error::Invalid(format!("invalid base64: {e}")))
}

/// Human-friendly recovery key: 32 random bytes rendered as groups of base32.
pub fn encode_recovery_key(key: &[u8; KEY_LEN]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
    let mut bits: u64 = 0;
    let mut nbits = 0;
    let mut out = String::new();
    for &b in key.iter() {
        bits = (bits << 8) | b as u64;
        nbits += 8;
        while nbits >= 5 {
            nbits -= 5;
            out.push(ALPHABET[((bits >> nbits) & 31) as usize] as char);
        }
    }
    if nbits > 0 {
        out.push(ALPHABET[((bits << (5 - nbits)) & 31) as usize] as char);
    }
    out.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-")
}

pub fn decode_recovery_key(s: &str) -> Result<SecretKey> {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut bits: u64 = 0;
    let mut nbits = 0;
    let mut out = Vec::with_capacity(KEY_LEN);
    for c in s.chars().filter(|c| c.is_ascii_alphanumeric()) {
        let c = c.to_ascii_uppercase() as u8;
        let v = ALPHABET
            .iter()
            .position(|&a| a == c)
            .ok_or_else(|| Error::Invalid("invalid recovery key character".into()))?;
        bits = (bits << 5) | v as u64;
        nbits += 5;
        if nbits >= 8 {
            nbits -= 8;
            out.push(((bits >> nbits) & 0xff) as u8);
        }
    }
    if out.len() != KEY_LEN {
        return Err(Error::Invalid("recovery key has wrong length".into()));
    }
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    key.copy_from_slice(&out);
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let key = random_key();
        let sealed = seal(&key, b"hello", b"ctx").unwrap();
        assert_eq!(&open(&key, &sealed, b"ctx").unwrap()[..], b"hello");
        assert!(open(&key, &sealed, b"other").is_err());
        let other = random_key();
        assert!(open(&other, &sealed, b"ctx").is_err());
    }

    #[test]
    fn kdf_is_deterministic() {
        let p = KdfParams::insecure_for_tests();
        let a = derive_master_key("pw", b"0123456789abcdef", &p).unwrap();
        let b = derive_master_key("pw", b"0123456789abcdef", &p).unwrap();
        let c = derive_master_key("pw2", b"0123456789abcdef", &p).unwrap();
        assert_eq!(*a, *b);
        assert_ne!(*a, *c);
    }

    #[test]
    fn recovery_key_roundtrip() {
        let key = random_key();
        let s = encode_recovery_key(&key);
        let back = decode_recovery_key(&s.to_lowercase()).unwrap();
        assert_eq!(*key, *back);
    }
}
