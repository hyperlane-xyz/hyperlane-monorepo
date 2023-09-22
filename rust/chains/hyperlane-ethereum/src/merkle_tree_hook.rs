#![allow(missing_docs)]
use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::Middleware;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Indexer, LogMeta, MerkleTreeInsertion,
    SequenceIndexer, H256,
};

use crate::contracts::i_mailbox::IMailbox as EthereumMailboxInternal;
use crate::contracts::merkle_tree_hook::MerkleTreeHook;
use crate::trait_builder::BuildableWithProvider;

pub struct MerkleTreeHookIndexerBuilder {
    pub finality_blocks: u32,
}

#[async_trait]
impl BuildableWithProvider for MerkleTreeHookIndexerBuilder {
    type Output = Box<dyn SequenceIndexer<MerkleTreeInsertion>>;

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
    contract: Arc<EthereumMailboxInternal<M>>,
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
            contract: Arc::new(EthereumMailboxInternal::new(
                locator.address,
                provider.clone(),
            )),
            provider,
            finality_blocks,
        }
    }

    // TODO: make this cache the required hook address at construction time
    pub async fn merkle_tree_hook(&self) -> ChainResult<MerkleTreeHook<M>> {
        let address = self.contract.required_hook().call().await?;
        Ok(MerkleTreeHook::new(address, self.provider.clone()))
    }
}

#[async_trait]
impl<M> Indexer<MerkleTreeInsertion> for EthereumMerkleTreeHookIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(MerkleTreeInsertion, LogMeta)>> {
        let merkle_tree_hook = self.merkle_tree_hook().await?;
        let events = merkle_tree_hook
            .inserted_into_tree_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?;

        let logs = events
            .into_iter()
            .map(|(log, log_meta)| {
                (
                    MerkleTreeInsertion::new(log.index, H256::from(log.message_id)),
                    log_meta.into(),
                )
            })
            .collect();
        Ok(logs)
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

#[async_trait]
impl<M> SequenceIndexer<MerkleTreeInsertion> for EthereumMerkleTreeHookIndexer<M>
where
    M: Middleware + 'static,
{
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // The InterchainGasPaymasterIndexerBuilder must return a `SequenceIndexer` type.
        // It's fine if only a blanket implementation is provided for EVM chains, since their
        // indexing only uses the `Index` trait, which is a supertrait of `SequenceIndexer`.
        // TODO: if `SequenceIndexer` turns out to not depend on `Indexer` at all, then the supertrait
        // dependency could be removed, even if the builder would still need to return a type that is both
        // ``SequenceIndexer` and `Indexer`.
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}
