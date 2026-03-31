use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::accumulator::incremental::IncrementalMerkle;
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use tracing::instrument;

use hyperlane_core::{
    ChainResult, Checkpoint, CheckpointAtBlock, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, IncrementalMerkleAtBlock, Indexed, Indexer, LogMeta,
    MerkleTreeHook, MerkleTreeInsertion, ReorgPeriod, SequenceAwareIndexer, H256, H512,
};

use crate::interfaces::merkle_tree_hook::{
    InsertedIntoTreeFilter, MerkleTreeHook as MerkleTreeHookContract, Tree,
};
use crate::{fetch_raw_logs_and_meta, TronProvider};

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
            .expect("Failed to convert vec into fixed sized array");
        IncrementalMerkle::new(branch, self.count.as_usize())
    }
}

#[derive(Debug)]
/// Struct that retrieves event data for a Tron MerkleTreeHook
pub struct TronMerkleTreeHookIndexer {
    contract: Arc<MerkleTreeHookContract<TronProvider>>,
    provider: Arc<TronProvider>,
}

impl TronMerkleTreeHookIndexer {
    /// Create new TronMerkleTreeHookIndexer
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        let provider = Arc::new(provider);
        Self {
            contract: Arc::new(MerkleTreeHookContract::new(
                locator.address,
                provider.clone(),
            )),
            provider,
        }
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for TronMerkleTreeHookIndexer {
    /// Note: This call may return duplicates depending on the provider used
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

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider.get_finalized_block_number().await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let raw_logs_and_meta = call_and_retry_indefinitely(|| {
            let provider = self.provider.clone();
            let contract = self.contract.address();
            Box::pin(async move {
                fetch_raw_logs_and_meta::<InsertedIntoTreeFilter, _>(tx_hash, provider, contract)
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
impl SequenceAwareIndexer<MerkleTreeInsertion> for TronMerkleTreeHookIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        let sequence = self.contract.count().block(u64::from(tip)).call().await?;
        Ok((Some(sequence), tip))
    }
}

/// A reference to a MerkleTreeHook contract on some Tron chain
#[derive(Debug)]
pub struct TronMerkleTreeHook {
    contract: Arc<MerkleTreeHookContract<TronProvider>>,
    domain: HyperlaneDomain,
    provider: Arc<TronProvider>,
}

impl TronMerkleTreeHook {
    /// Create new TronMerkleTreeHook
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        let provider = Arc::new(provider);
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

impl HyperlaneChain for TronMerkleTreeHook {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for TronMerkleTreeHook {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl MerkleTreeHook for TronMerkleTreeHook {
    /// Note: reorg_period is not used in this implementation
    /// because the Tron's view calls happen on the solidified node which is already finalized.
    #[instrument(skip(self))]
    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        let (root, index) = self.contract.latest_checkpoint().call().await?;
        let checkpoint = Checkpoint {
            merkle_tree_hook_address: self.address(),
            mailbox_domain: self.domain.id(),
            root: root.into(),
            index,
        };
        Ok(CheckpointAtBlock {
            checkpoint,
            block_height: None,
        })
    }

    #[instrument(skip(self))]
    async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock> {
        // Note: We can't use a specific block height for the call because Tron view calls
        // don't support it.
        let (root, index) = self.contract.latest_checkpoint().call().await?;
        let checkpoint = Checkpoint {
            merkle_tree_hook_address: self.address(),
            mailbox_domain: self.domain.id(),
            root: root.into(),
            index,
        };
        Ok(CheckpointAtBlock {
            checkpoint,
            block_height: Some(height),
        })
    }

    /// Note: reorg_period is not used in this implementation
    /// because the Tron's view calls happen on the solidified node which is already finalized.
    #[instrument(skip(self))]
    #[allow(clippy::needless_range_loop)]
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        let tree = self.contract.tree().call().await?;

        Ok(IncrementalMerkleAtBlock {
            tree: tree.into(),
            block_height: None,
        })
    }

    /// Note: reorg_period is not used in this implementation
    /// because the Tron's view calls happen on the solidified node which is already finalized.
    #[instrument(skip(self))]
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let count = self.contract.count().call().await?;
        Ok(count)
    }
}
