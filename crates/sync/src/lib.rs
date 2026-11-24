//! Termindo sync.
//!
//! * [`protocol`]: JSON types exchanged with the sync server (shared with `apps/server`).
//! * [`envelope`]: record encryption. The server only ever sees ids, timestamps,
//!   a tombstone flag and opaque ciphertext.
//! * [`engine`] / [`client`]: push dirty records, pull remote changes, merge with LWW.

pub mod envelope;
pub mod protocol;

#[cfg(feature = "client")]
pub mod client;
#[cfg(feature = "client")]
pub mod engine;
