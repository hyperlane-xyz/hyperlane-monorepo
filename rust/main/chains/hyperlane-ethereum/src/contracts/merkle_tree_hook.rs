#![allow(missing_docs)]
use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::Middleware;
use ethers_contract::builders::ContractCall;
use ethers_core::types::{BlockId, BlockNumber};
use hyperlane_core::accumulator::incremental::IncrementalMerkle;
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use tracing::instrument;

use hyperlane_core::{
    ChainResult, Checkpoint, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, IncrementalMerkleAtBlockHeight, Indexed, Indexer, LogMeta, MerkleTreeHook,
    MerkleTreeInsertion, ReorgPeriod, SequenceAwareIndexer, H256, H512,
};

use crate::interfaces::merkle_tree_hook::{
    InsertedIntoTreeFilter, MerkleTreeHook as MerkleTreeHookContract, Tree,
};
use crate::tx::call_with_reorg_period;
use crate::{BuildableWithProvider, ConnectionConf, EthereumProvider, EthereumReorgPeriod};

use super::utils::{fetch_raw_logs_and_meta, get_finalized_block_number};

// We don't need the reverse of this impl, so it's ok to disable the clippy lint
#[allow(clippy::from_over_into)]
impl Into<IncrementalMerkle> for Tree {
    fn into(self) -> IncrementalMerkle {
        let branch = self
            .branch
            .iter()
            .map(|v| v.into())
            .collect::<Vec<_>>()
            // we're iterating over a fixed-size array and want to collect into a
            // fixed-size array of the same size (32), so this is safe
            .try_into()
            .unwrap();
        IncrementalMerkle::new(branch, self.count.as_usize())
    }
}

pub struct MerkleTreeHookBuilder {}

#[async_trait]
impl BuildableWithProvider for MerkleTreeHookBuilder {
    type Output = Box<dyn MerkleTreeHook>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMerkleTreeHook::new(Arc::new(provider), locator))
    }
}

pub struct MerkleTreeHookIndexerBuilder {
    pub reorg_period: EthereumReorgPeriod,
}

#[async_trait]
impl BuildableWithProvider for MerkleTreeHookIndexerBuilder {
    type Output = Box<dyn SequenceAwareIndexer<MerkleTreeInsertion>>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMerkleTreeHookIndexer::new(
            Arc::new(provider),
            locator,
            self.reorg_period,
        ))
    }
}

#[derive(Debug)]
/// Struct that retrieves event data for an Ethereum MerkleTreeHook
pub struct EthereumMerkleTreeHookIndexer<M>
where
    M: Middleware,
{
    contract: Arc<MerkleTreeHookContract<M>>,
    provider: Arc<M>,
    reorg_period: EthereumReorgPeriod,
}

impl<M> EthereumMerkleTreeHookIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create new EthereumMerkleTreeHookIndexer
    pub fn new(
        provider: Arc<M>,
        locator: &ContractLocator,
        reorg_period: EthereumReorgPeriod,
    ) -> Self {
        Self {
            contract: Arc::new(MerkleTreeHookContract::new(
                locator.address,
                provider.clone(),
            )),
            provider,
            reorg_period,
        }
    }
}

#[async_trait]
impl<M> Indexer<MerkleTreeInsertion> for EthereumMerkleTreeHookIndexer<M>
where
    M: Middleware + 'static,
{
    /// Note: This call may return duplicates depending on the provider used
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let events = self
            .contract
            .inserted_into_tree_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?;

        let logs = events
            .into_iter()
            .map(|(log, log_meta)| {
                (
                    MerkleTreeInsertion::new(log.index, H256::from(log.message_id)).into(),
                    log_meta.into(),
                )
            })
            .collect();
        Ok(logs)
    }

    #[instrument(level = "debug", err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        get_finalized_block_number(&self.provider, &self.reorg_period).await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let raw_logs_and_meta = call_and_retry_indefinitely(|| {
            let provider = self.provider.clone();
            let contract = self.contract.address();
            Box::pin(async move {
                fetch_raw_logs_and_meta::<InsertedIntoTreeFilter, M>(tx_hash, provider, contract)
                    .await
            })
        })
        .await;
        let logs = raw_logs_and_meta
            .into_iter()
            .map(|(log, log_meta)| {
                (
                    MerkleTreeInsertion::new(log.index, H256::from(log.message_id)).into(),
                    log_meta,
                )
            })
            .collect();
        Ok(logs)
    }
}

#[async_trait]
impl<M> SequenceAwareIndexer<MerkleTreeInsertion> for EthereumMerkleTreeHookIndexer<M>
where
    M: Middleware + 'static,
{
    // TODO: if `SequenceAwareIndexer` turns out to not depend on `Indexer` at all, then the supertrait
    // dependency could be removed, even if the builder would still need to return a type that is both
    // `SequenceAwareIndexer` and `Indexer`.
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        let sequence = self.contract.count().block(u64::from(tip)).call().await?;
        Ok((Some(sequence), tip))
    }
}

/// A reference to a Mailbox contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumMerkleTreeHook<M>
where
    M: Middleware,
{
    contract: Arc<MerkleTreeHookContract<M>>,
    domain: HyperlaneDomain,
    provider: Arc<M>,
}

impl<M> EthereumMerkleTreeHook<M>
where
    M: Middleware,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(MerkleTreeHookContract::new(
                locator.address,
                provider.clone(),
            )),
            domain: locator.domain.clone(),
            provider,
        }
    }
}

impl<M> HyperlaneChain for EthereumMerkleTreeHook<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.provider.clone(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumMerkleTreeHook<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> MerkleTreeHook for EthereumMerkleTreeHook<M>
where
    M: Middleware + 'static,
{
    #[instrument(skip(self))]
    async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint> {
        let call = call_with_reorg_period(
            self.contract.latest_checkpoint(),
            &self.provider,
            reorg_period,
        )
        .await?;

        let block_height = Self::block_height(&call);

        let (root, index) = call.call().await?;
        Ok(Checkpoint {
            merkle_tree_hook_address: self.address(),
            mailbox_domain: self.domain.id(),
            root: root.into(),
            index,
            block_height,
        })
    }

    #[instrument(skip(self))]
    async fn latest_checkpoint_at_height(&self, height: u64) -> ChainResult<Checkpoint> {
        let call = self
            .contract
            .latest_checkpoint()
            .block(BlockId::Number(BlockNumber::Number(height.into())));

        let (root, index) = call.call().await?;
        Ok(Checkpoint {
            merkle_tree_hook_address: self.address(),
            mailbox_domain: self.domain.id(),
            root: root.into(),
            index,
            block_height: height,
        })
    }

    #[instrument(skip(self))]
    #[allow(clippy::needless_range_loop)]
    async fn tree(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<IncrementalMerkleAtBlockHeight> {
        let call =
            call_with_reorg_period(self.contract.tree(), &self.provider, reorg_period).await?;
        let tree = call.call().await?;
        let block_height = Self::block_height(&call);

        Ok(IncrementalMerkleAtBlockHeight {
            tree: tree.into(),
            block_height,
        })
    }

    #[instrument(skip(self))]
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let call =
            call_with_reorg_period(self.contract.count(), &self.provider, reorg_period).await?;
        let count = call.call().await?;
        Ok(count)
    }
}

impl<M> EthereumMerkleTreeHook<M>
where
    M: 'static + Middleware,
{
    fn block_height<D>(call: &ContractCall<M, D>) -> u64 {
        // We expect that block height is always set, otherwise we default to 0
        let block_height = call
            .block
            .map(|id| match id {
                BlockId::Hash(_) => 0u64,
                BlockId::Number(n) => n.as_number().map(|n| n.as_u64()).unwrap_or(0u64),
            })
            .unwrap_or(0u64);
        block_height
    }
}
