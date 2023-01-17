use async_trait::async_trait;
use hyperlane_core::{HyperlaneDomain, H256};

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, Indexer, InterchainGasPaymaster,
    InterchainGasPaymasterIndexer, InterchainGasPaymentWithMeta,
};

/// A reference to an IGP contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainGasPaymaster {}

impl HyperlaneContract for SealevelInterchainGasPaymaster {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for SealevelInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }
}

impl InterchainGasPaymaster for SealevelInterchainGasPaymaster {}

/// Struct that retrieves event data for a Sealevel IGP contract
#[derive(Debug)]
pub struct SealevelInterchainGasPaymasterIndexer {}

#[async_trait]
impl Indexer for SealevelInterchainGasPaymasterIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        todo!()
    }
}

#[async_trait]
impl InterchainGasPaymasterIndexer for SealevelInterchainGasPaymasterIndexer {
    async fn fetch_gas_payments(
        &self,
        from_block: u32,
        to_block: u32,
    ) -> ChainResult<Vec<InterchainGasPaymentWithMeta>> {
        todo!()
    }
}
