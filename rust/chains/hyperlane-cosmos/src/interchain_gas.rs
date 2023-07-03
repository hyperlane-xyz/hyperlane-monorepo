use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, Indexer, InterchainGasPaymaster,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneProvider, InterchainGasPayment, LogMeta, H256};

#[derive(Debug)]
pub struct CosmosInterchainGasPaymaster {}

impl HyperlaneContract for CosmosInterchainGasPaymaster {
    fn address(&self) -> H256 {
        todo!()
    }
}

impl HyperlaneChain for CosmosInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

impl InterchainGasPaymaster for CosmosInterchainGasPaymaster {}

#[derive(Debug)]
pub struct CosmosInterchainGasPaymasterIndexer {}

#[async_trait]
impl Indexer<InterchainGasPayment> for CosmosInterchainGasPaymasterIndexer {
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
