use async_trait::async_trait;

use hyperlane_core::{BlockInfo, ChainResult, HyperlaneChain, HyperlaneProvider, TxnInfo, H256};

/// A wrapper around a fuel provider to get generic blockchain information.
#[derive(Debug)]
pub struct FuelProvider {}

impl HyperlaneChain for FuelProvider {
    fn chain_name(&self) -> &str {
        todo!()
    }

    fn domain(&self) -> u32 {
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
}
