use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::Middleware;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator,
    IndexRange::{self, BlockRange},
    Indexer, LogMeta, H160, H256,
};

use crate::{contracts::mailbox, trait_builder::BuildableWithProvider};
use crate::{
    contracts::merkle_tree_hook::MerkleTreeHook as MerkleTreeHookInternal, EthereumMailbox,
};

pub struct MerkleTreeHookIndexerBuilder {
    pub merkle_tree_hook_address: H160,
    pub finality_blocks: u32,
}

#[async_trait]
impl BuildableWithProvider for MerkleTreeHookIndexerBuilder {
    type Output = Box<dyn Indexer<H256>>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMerkleTreeHookIndexer::new(
            Arc::new(provider),
            locator,
            self.finality_blocks,
        ))
    }
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
    /// Create new EthereumMerkleTreeHookIndexer
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
    async fn fetch_logs(&self, range: IndexRange) -> ChainResult<Vec<(H256, LogMeta)>> {
        let BlockRange(range) = range else {
            return Err(ChainCommunicationError::from_other_str(
                "EthereumMerkleTreeHookIndexer only supports block-based indexing",
            ));
        };

        let events = self
            .contract
            .inserted_into_tree_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?;

        Ok(events
            .into_iter()
            .map(|(log, log_meta)| (H256::from(log.message_id), log_meta.into()))
            .collect())
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
