use eyre::{bail, ContextCompat};

use hyperlane_base::settings::{ChainConf, ChainConnectionConf, SignerConf};
use hyperlane_sealevel::{create_keypair as create_raw_keypair, ConnectionConf, SealevelKeypair};
use solana_sdk::signature::Signer;

#[allow(clippy::panic)]
pub fn get_connection_conf(conf: &ChainConf) -> &ConnectionConf {
    match &conf.connection {
        ChainConnectionConf::Sealevel(connection_conf) => connection_conf,
        _ => panic!(),
    }
}

pub fn create_keypair(conf: &ChainConf) -> eyre::Result<SealevelKeypair> {
    let signer = conf.signer.as_ref().wrap_err("Signer is missing")?;
    let key = match signer {
        SignerConf::HexKey { key } => key,
        _ => bail!("Sealevel supports only hex key"),
    };
    let keypair = create_raw_keypair(key)?;
    Ok(SealevelKeypair(keypair))
}

/// Returns the identity keypair if configured and distinct from the payer, otherwise `None`.
/// Used as a co-signer for TrustedRelayer ISMs.
pub fn create_identity_keypair(
    conf: &ChainConf,
    payer: &SealevelKeypair,
) -> eyre::Result<Option<SealevelKeypair>> {
    let identity_conf = match &conf.identity {
        Some(c) => c,
        None => return Ok(None),
    };
    let key = match identity_conf {
        SignerConf::HexKey { key } => key,
        _ => bail!("Sealevel supports only hex key for identity"),
    };
    let keypair = SealevelKeypair(create_raw_keypair(key)?);
    if keypair.pubkey() == payer.pubkey() {
        return Ok(None);
    }
    Ok(Some(keypair))
}
