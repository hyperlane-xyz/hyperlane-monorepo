use eyre::{bail, ContextCompat};

use hyperlane_base::settings::{ChainConf, SignerConf};
use hyperlane_tron::TronSigner;

pub fn create_signer(conf: &ChainConf) -> eyre::Result<TronSigner> {
    let signer_conf = conf.signer.as_ref().wrap_err("Signer is missing")?;
    if let SignerConf::HexKey { key } = signer_conf {
        let key = ethers::core::k256::SecretKey::from_be_bytes(key.as_bytes())?;
        let wallet = ethers::core::k256::ecdsa::SigningKey::from(key);
        Ok(hyperlane_tron::TronSigner::from(wallet))
    } else {
        bail!(format!("{conf:?} key is not supported by tron"));
    }
}
