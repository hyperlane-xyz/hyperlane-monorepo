use std::str::FromStr as _;

use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, MultisigIsm,
    H256, HyperlaneProvider,
};
use tracing::warn;

use crate::{ConnectionConf, solana::pubkey::Pubkey, SealevelProvider};

/// A reference to a MultisigIsm contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelMultisigIsm {
    program_id: Pubkey,
    domain: HyperlaneDomain,
}

impl SealevelMultisigIsm {
    pub fn new(_conf: &ConnectionConf, locator: ContractLocator) -> Self {
        // let rpc_client = RpcClient::new(conf.url.clone());
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));

        Self {
            program_id,
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneContract for SealevelMultisigIsm {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(SealevelProvider::new(self.domain.clone()))
    }
}

#[async_trait]
impl MultisigIsm for SealevelMultisigIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        _message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        // FIXME get the validator set from the ISM contract
        warn!("Providing a single hardcoded validator and threshold of 1 for multisig ism");
        let address = H256::from_str(
            "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8"
        ).map_err(ChainCommunicationError::from_other)?;
        Ok((vec![address], 1))
    }
}
