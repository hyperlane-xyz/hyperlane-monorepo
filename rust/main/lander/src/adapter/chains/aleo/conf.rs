use hyperlane_aleo::AleoSigner;
use hyperlane_base::settings::{ChainConf, SignerConf};

use crate::LanderError;

/// Creates an Aleo signer from configuration
pub fn create_signer(conf: &ChainConf) -> Result<AleoSigner, LanderError> {
    let signer_conf = conf.signer.as_ref().ok_or_else(|| {
        LanderError::NonRetryableError("Missing signer configuration".to_string())
    })?;

    if let SignerConf::HexKey { key } = signer_conf {
        AleoSigner::new(key.as_bytes()).map_err(|e| {
            LanderError::NonRetryableError(format!("Failed to create Aleo signer: {e}"))
        })
    } else {
        Err(LanderError::NonRetryableError(
            "Unsupported signer configuration for Aleo; only HexKey is supported".to_string(),
        ))
    }
}
