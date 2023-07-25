use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, IndexRange, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    H256,
};
use tracing::{info, instrument};

use crate::{ConnectionConf, SealevelProvider};
use solana_sdk::pubkey::Pubkey;

/// A reference to an IGP contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainGasPaymaster {
    program_id: Pubkey,
    domain: HyperlaneDomain,
}

impl SealevelInterchainGasPaymaster {
    /// Create a new Sealevel IGP.
    pub fn new(_conf: &ConnectionConf, locator: ContractLocator) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            program_id,
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneContract for SealevelInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(SealevelProvider::new(self.domain.clone()))
    }
}

impl InterchainGasPaymaster for SealevelInterchainGasPaymaster {}

/// Struct that retrieves event data for a Sealevel IGP contract
#[derive(Debug)]
pub struct SealevelInterchainGasPaymasterIndexer {}

impl SealevelInterchainGasPaymasterIndexer {
    /// Create a new Sealevel IGP indexer.
    pub fn new(_conf: &ConnectionConf, _locator: ContractLocator) -> Self {
        Self {}
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for SealevelInterchainGasPaymasterIndexer {
    #[instrument(err, skip(self))]
    async fn fetch_logs(
        &self,
        _range: IndexRange,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        info!("Gas payment indexing not implemented for Sealevel");
        Ok(vec![])
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        // As a workaround to avoid gas payment indexing on Sealevel,
        // we pretend the block number is 1.
        Ok(1)
    }
}
