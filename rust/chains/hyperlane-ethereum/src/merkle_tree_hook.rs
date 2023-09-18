use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::Middleware;
use tracing::instrument;

use hyperlane_core::{H160, ContractLocator, Indexer, H256, IndexRange::{self, BlockRange}, ChainResult, LogMeta, ChainCommunicationError};

use crate::contracts::merkle_tree_hook::MerkleTreeHook as MerkleTreeHookInternal;

pub struct MerkleTreeHookIndexerBuilder {
    pub merkle_tree_hook_address: H160,
    pub finality_blocks: u32,
}

#[derive(Debug)]
/// Struct that retrieves event data for an Ethereum MerkleTreeHook
pub struct EthereumMerkleTreeHookIndexer<M>
where
    M: Middleware,
{
    contract: Arc<MerkleTreeHookInternal<M>>,
    provider: Arc<M>,
    finality_blocks: u32,
}

impl<M> EthereumMerkleTreeHookIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create new EthereumInterchainGasPaymasterIndexer
    pub fn new(provider: Arc<M>, locator: &ContractLocator, finality_blocks: u32) -> Self {
        Self {
            contract: Arc::new(MerkleTreeHookInternal::new(
                locator.address,
                provider.clone(),
            )),
            provider,
            finality_blocks,
        }
    }
}

#[async_trait]
impl<M> Indexer<H256> for EthereumMerkleTreeHookIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn fetch_logs(
        &self,
        range: IndexRange,
    ) -> ChainResult<Vec<(H256, LogMeta)>> {
        let BlockRange(range) = range else {
            return Err(ChainCommunicationError::from_other_str(
                "EthereumMerkleTreeHookIndexer only supports block-based indexing",
            ));
        };

        // let events = self.contract.inserted

        // TODO
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(self
            .provider
            .get_block_number()
            .await
            .map_err(ChainCommunicationError::from_other)?
            .as_u32()
            .saturating_sub(self.finality_blocks))
    }
}