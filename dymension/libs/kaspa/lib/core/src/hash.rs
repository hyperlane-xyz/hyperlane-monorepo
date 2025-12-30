use eyre::{eyre, Result};
use kaspa_hashes::Hash as KaspaHash;

/// Convert a hex string to a Kaspa hash.
pub fn hex_to_kaspa_hash(hex_str: &str) -> Result<KaspaHash> {
    let bytes = hex::decode(hex_str).map_err(|e| eyre!("invalid hex: {}", e))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| eyre!("invalid hash length: expected 32 bytes"))?;
    Ok(KaspaHash::from_bytes(arr))
}
