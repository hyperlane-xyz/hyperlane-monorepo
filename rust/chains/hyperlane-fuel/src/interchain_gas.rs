use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, Indexer, InterchainGasPaymaster,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneProvider, InterchainGasPayment, LogMeta, H256};

/// A reference to an IGP contract on some Fuel chain
#[derive(Debug)]
pub struct FuelInterchainGasPaymaster {}

impl HyperlaneContract for FuelInterchainGasPaymaster {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for FuelInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

impl InterchainGasPaymaster for FuelInterchainGasPaymaster {}

/// Struct that retrieves event data for a Fuel IGP contract
#[derive(Debug)]
pub struct FuelInterchainGasPaymasterIndexer {}

#[async_trait]
impl Indexer<InterchainGasPayment> for FuelInterchainGasPaymasterIndexer {
    async fn fetch_logs(
        &self,
        from_block: u32,
        to_block: u32,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        todo!()
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        todo!()
    }
}
