use eyre::{Context, Result};
use solana_sdk::signer::keypair::Keypair;

use hyperlane_core::H256;

/// Creates keypair from secret key
pub fn create_keypair(key: &H256) -> Result<Keypair> {
    let secret = ed25519_dalek::SecretKey::from_bytes(key.as_bytes())
        .context("Invalid sealevel ed25519 secret key")?;
    let public = ed25519_dalek::PublicKey::from(&secret);
    let dalek = ed25519_dalek::Keypair { secret, public };
    let keypair = Keypair::from_bytes(&dalek.to_bytes()).context("Unable to create Keypair")?;
    Ok(keypair)
}
