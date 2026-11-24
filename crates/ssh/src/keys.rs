//! SSH key generation and inspection.

use rand::RngCore;
use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
use russh::keys::ssh_key::LineEnding;
use russh::keys::{HashAlg, PrivateKey};
use zeroize::Zeroizing;

use crate::error::{Result, SshError};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub algorithm: String,
    pub public_key: String,
    pub fingerprint: String,
    pub encrypted: bool,
}

/// Generate a new Ed25519 key. Returns (OpenSSH private key PEM, public key line).
pub fn generate_ed25519(comment: &str) -> Result<(Zeroizing<String>, String)> {
    let mut seed = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(seed.as_mut());
    let pair = Ed25519Keypair::from_seed(&seed);
    let key = PrivateKey::new(KeypairData::from(pair), comment)
        .map_err(|e| SshError::Other(format!("key generation failed: {e}")))?;
    let private = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| SshError::Other(format!("key encoding failed: {e}")))?;
    let public = key
        .public_key()
        .to_openssh()
        .map_err(|e| SshError::Other(format!("key encoding failed: {e}")))?;
    Ok((Zeroizing::new(private.to_string()), public))
}

/// Whether a private key PEM is passphrase protected.
pub fn is_encrypted(pem: &str) -> bool {
    if pem.contains("ENCRYPTED") {
        return true;
    }
    matches!(
        russh::keys::decode_secret_key(pem, None),
        Err(russh::keys::Error::KeyIsEncrypted)
    )
}

/// Parse a private key (decrypting it if needed) and describe its public half.
pub fn inspect_private_key(pem: &str, passphrase: Option<&str>) -> Result<KeyInfo> {
    let encrypted = is_encrypted(pem);
    let key = russh::keys::decode_secret_key(pem, passphrase).map_err(|e| match e {
        russh::keys::Error::KeyIsEncrypted => {
            SshError::Other("the key is encrypted: enter its passphrase".into())
        }
        other => SshError::Other(format!("invalid private key: {other}")),
    })?;
    let public = key.public_key();
    Ok(KeyInfo {
        algorithm: public.algorithm().as_str().to_string(),
        public_key: public.to_openssh().unwrap_or_default(),
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        encrypted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_and_inspect() {
        let (private, public) = generate_ed25519("test@termindo").unwrap();
        assert!(private.contains("BEGIN OPENSSH PRIVATE KEY"));
        assert!(public.starts_with("ssh-ed25519 "));
        let info = inspect_private_key(&private, None).unwrap();
        assert_eq!(info.algorithm, "ssh-ed25519");
        assert!(info.fingerprint.starts_with("SHA256:"));
        assert!(!info.encrypted);
        assert_eq!(
            info.public_key.split_whitespace().nth(1),
            public.split_whitespace().nth(1)
        );
    }
}
