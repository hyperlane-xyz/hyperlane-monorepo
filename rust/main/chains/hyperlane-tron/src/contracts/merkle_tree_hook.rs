use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::accumulator::incremental::IncrementalMerkle;
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;

use hyperlane_core::{
    ChainResult, ContractLocator, Indexed, Indexer, LogMeta, MerkleTreeInsertion,
    SequenceAwareIndexer, H256, H512,
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
