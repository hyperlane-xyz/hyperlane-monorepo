use eyre::{bail, Context, Report, Result};
use solana_sdk::signer::keypair::Keypair;

use hyperlane_base::settings::parser::h_sealevel::SealevelKeypair;
use hyperlane_base::settings::SignerConf;

pub fn create_keypair(conf: &SignerConf) -> Result<SealevelKeypair> {
    if let SignerConf::HexKey { key } = conf {
        let secret = ed25519_dalek::SecretKey::from_bytes(key.as_bytes())
            .context("Invalid sealevel ed25519 secret key")?;
        let public = ed25519_dalek::PublicKey::from(&secret);
        let dalek = ed25519_dalek::Keypair { secret, public };
        let keypair = Keypair::from_bytes(&dalek.to_bytes()).context("Unable to create Keypair")?;
        Ok(SealevelKeypair(keypair))
    } else {
        bail!(format!("{conf:?} key is not supported by sealevel"));
    }
}
