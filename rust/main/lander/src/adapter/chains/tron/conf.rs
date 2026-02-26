use eyre::ContextCompat;

use hyperlane_base::settings::{BuildableWithSignerConf, ChainConf};
use hyperlane_tron::TronSigner;

pub async fn create_signer(conf: &ChainConf) -> eyre::Result<TronSigner> {
    let signer_conf = conf.signer.as_ref().wrap_err("Signer is missing")?;
    signer_conf.build::<TronSigner>().await
}
