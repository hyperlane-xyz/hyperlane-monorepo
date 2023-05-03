use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, ValidatorAnnounce, H256, ContractLocator,
};

use crate::{solana::pubkey::Pubkey, ConnectionConf};

/// A reference to a ValidatorAnnounce contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelValidatorAnnounce {
    program_id: Pubkey,
    domain: HyperlaneDomain,
}

impl SealevelValidatorAnnounce {
    /// Create a new sealevel mailbox
    pub fn new(
        _conf: &ConnectionConf,
        locator: ContractLocator,
    ) -> Self {
        // TODO use helper functions from mailbox contract lib
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            program_id,
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneContract for SealevelValidatorAnnounce {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        Box::new(crate::SealevelProvider::new(self.domain.clone()))
    }
}

#[async_trait]
impl ValidatorAnnounce for SealevelValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        _validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        // TODO: actually get this data from the validator announce contract
        // Hardcoded to match config/sealevel/validator.env's checkpoint directory
        // for test validator 0x70997970c51812dc3a010c7d01b50e0d17dc79c8.
        Ok(vec![vec!["file:///tmp/test_sealevel_checkpoints_0x70997970c51812dc3a010c7d01b50e0d17dc79c8".into()]])
    }
}
