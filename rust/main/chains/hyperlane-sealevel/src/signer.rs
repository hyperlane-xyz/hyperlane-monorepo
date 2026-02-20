use eyre::{Context, Result};
use solana_sdk::signer::keypair::Keypair;

use hyperlane_core::H256;

/// Creates keypair from secret key
pub fn create_keypair(key: &H256) -> Result<Keypair> {
    // ed25519-dalek v2.x uses SigningKey instead of SecretKey/Keypair
    // H256 is 32 bytes, convert slice to fixed array
    let key_bytes: &[u8; 32] = key.as_fixed_bytes();
    let signing_key = ed25519_dalek::SigningKey::from_bytes(key_bytes);
    let keypair_bytes = signing_key.to_keypair_bytes();
    let keypair =
        Keypair::try_from(keypair_bytes.as_slice()).context("Unable to create Keypair")?;
    Ok(keypair)
}
