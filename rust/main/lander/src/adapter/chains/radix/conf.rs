use eyre::{bail, ContextCompat};

use hyperlane_base::settings::{ChainConf, SignerConf};
use hyperlane_radix::RadixSigner;

pub fn create_signer(conf: &ChainConf) -> eyre::Result<RadixSigner> {
    let signer_conf = conf.signer.as_ref().wrap_err("Signer is missing")?;
    if let SignerConf::RadixKey { key, suffix } = signer_conf {
        Ok(hyperlane_radix::RadixSigner::new(
            key.as_bytes().to_vec(),
            suffix.to_string(),
        )?)
    } else {
        bail!(format!("{conf:?} key is not supported by radix"));
    }
}
