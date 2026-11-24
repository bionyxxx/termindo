//! End-to-end encryption of sync records.
//!
//! `blob = base64( nonce || XChaCha20-Poly1305(DEK, json(payload), aad = "termindo/record/v1:" + id) )`
//!
//! Binding the record id as associated data stops the server from swapping
//! ciphertexts between records.

use serde::{Deserialize, Serialize};
use termindo_core::crypto::{self, KEY_LEN};
use termindo_core::models::Entity;
use termindo_core::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordPayload {
    /// Entity kind, e.g. `host` (see [`Entity::KIND`]).
    pub kind: String,
    pub data: serde_json::Value,
}

fn aad(id: &str) -> Vec<u8> {
    format!("termindo/record/v1:{id}").into_bytes()
}

pub fn seal_entity<T: Entity>(dek: &[u8; KEY_LEN], item: &T) -> Result<String> {
    let payload = RecordPayload {
        kind: T::KIND.to_string(),
        data: serde_json::to_value(item)?,
    };
    let json = serde_json::to_vec(&payload)?;
    Ok(crypto::b64(&crypto::seal(dek, &json, &aad(item.id()))?))
}

pub fn open_payload(dek: &[u8; KEY_LEN], id: &str, blob: &str) -> Result<RecordPayload> {
    let sealed = crypto::unb64(blob)?;
    let json = crypto::open(dek, &sealed, &aad(id))?;
    let payload: RecordPayload = serde_json::from_slice(&json)?;
    Ok(payload)
}

/// Decode a payload into a concrete entity, checking that the embedded id matches.
pub fn decode_entity<T: Entity>(id: &str, payload: RecordPayload) -> Result<T> {
    let item: T = serde_json::from_value(payload.data)?;
    if item.id() != id {
        return Err(Error::Crypto("record id mismatch".into()));
    }
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::*;
    use termindo_core::models::Snippet;

    #[test]
    fn roundtrip_and_binding() {
        let dek = crypto::random_key();
        let s = Snippet {
            id: "s1".into(),
            name: "n".into(),
            body: "uptime".into(),
            hotkey: None,
            tags: vec![],
            updated_at: 5,
            deleted_at: None,
        };
        let blob = seal_entity(&dek, &s).unwrap();
        let payload = open_payload(&dek, "s1", &blob).unwrap();
        assert_eq!(payload.kind, "snippet");
        let back: Snippet = decode_entity("s1", payload).unwrap();
        assert_eq!(back, s);
        assert!(open_payload(&dek, "s2", &blob).is_err());
    }
}
