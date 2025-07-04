use eyre::{bail, ContextCompat};

use hyperlane_base::settings::{ChainConf, ChainConnectionConf, SignerConf};
use hyperlane_sealevel::{create_keypair as create_raw_keypair, ConnectionConf, SealevelKeypair};

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
