use async_trait::async_trait;

use hyperlane_core::{
    BlockInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneProvider, TxnInfo, H256,
};

/// A wrapper around a fuel provider to get generic blockchain information.
#[derive(Debug)]
pub struct FuelProvider {}

impl HyperlaneChain for FuelProvider {
    fn domain(&self) -> &HyperlaneDomain {
        todo!()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        todo!()
    }
}

#[async_trait]
impl HyperlaneProvider for FuelProvider {
    async fn get_block_by_hash(&self, hash: &H256) -> ChainResult<BlockInfo> {
        todo!()
    }

    async fn get_txn_by_hash(&self, hash: &H256) -> ChainResult<TxnInfo> {
        todo!()
    }

    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        todo!()
    }

    async fn get_storage_at(&self, address: H256, location: H256) -> ChainResult<H256> {
        todo!()
    }
}
