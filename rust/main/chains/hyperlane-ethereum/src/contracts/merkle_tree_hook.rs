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
    ChainCommunicationError, ChainResult, Checkpoint, CheckpointAtBlock, ContractLocator,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider,
    IncrementalMerkleAtBlock, Indexed, Indexer, LogMeta, MerkleTreeHook, MerkleTreeInsertion,
    ReorgPeriod, SequenceAwareIndexer, H256, H512,
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
            .expect("Failed to convert vec into fixed sized array");
        IncrementalMerkle::new(branch, self.count.as_usize())
    }
}

pub struct MerkleTreeHookBuilder {}

#[async_trait]
impl BuildableWithProvider for MerkleTreeHookBuilder {
    type Output = Box<dyn MerkleTreeHook>;
    const NEEDS_SIGNER: bool = false;

    fn uses_dynamic_block_cache(&self) -> bool {
        true
    }

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

    fn uses_dynamic_block_cache(&self) -> bool {
        true
    }

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
                    .await?
                    .ok_or_else(|| {
                        ChainCommunicationError::CustomError(format!(
                            "No receipt found for tx hash {tx_hash:?}"
                        ))
                    })
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
    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        let call = call_with_reorg_period(
            self.contract.latest_checkpoint(),
            &self.provider,
            reorg_period,
        )
        .await?;

        let block_height = Self::block_height(&call);

        let (root, index) = call.call().await?;
        let checkpoint = Checkpoint {
            merkle_tree_hook_address: self.address(),
            mailbox_domain: self.domain.id(),
            root: root.into(),
            index,
        };
        Ok(CheckpointAtBlock {
            checkpoint,
            block_height,
        })
    }

    #[instrument(skip(self))]
    async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock> {
        let call = self
            .contract
            .latest_checkpoint()
            .block(BlockId::Number(BlockNumber::Number(height.into())));

        let (root, index) = call.call().await?;
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

    #[instrument(skip(self))]
    #[allow(clippy::needless_range_loop)]
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        let call =
            call_with_reorg_period(self.contract.tree(), &self.provider, reorg_period).await?;
        let tree = call.call().await?;
        let block_height = Self::block_height(&call);

        Ok(IncrementalMerkleAtBlock {
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

    #[instrument(skip(self))]
    async fn tree_at_block(&self, height: u64) -> ChainResult<IncrementalMerkleAtBlock> {
        let call = self
            .contract
            .tree()
            .block(BlockId::Number(BlockNumber::Number(height.into())));
        let tree = call.call().await?;
        Ok(IncrementalMerkleAtBlock {
            tree: tree.into(),
            block_height: Some(height),
        })
    }
}

impl<M> EthereumMerkleTreeHook<M>
where
    M: 'static + Middleware,
{
    fn block_height<D>(call: &ContractCall<M, D>) -> Option<u64> {
        if let Some(BlockId::Number(BlockNumber::Number(n))) = call.block {
            return Some(n.as_u64());
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use ethers::providers::{MockProvider, Provider};
    use ethers_core::{
        abi::{encode, Token},
        types::{Bytes, U64},
    };
    use ethers_prometheus::json_rpc_client::PrometheusJsonRpcClient;
    use hyperlane_core::KnownHyperlaneDomain;

    use super::*;

    fn cached_provider(
        endpoint: &str,
    ) -> (
        Provider<PrometheusJsonRpcClient<MockProvider>>,
        MockProvider,
    ) {
        let mock = MockProvider::new();
        let client = MerkleTreeHookBuilder {}.wrap_rpc_with_metrics(
            mock.clone(),
            endpoint.parse().expect("valid test endpoint"),
            &None,
            &None,
        );
        (Provider::new(client), mock)
    }

    #[tokio::test]
    async fn hook_builder_reuses_tip_but_reads_same_count_replacement_root() {
        let (provider, mock) = cached_provider("http://localhost/hook-root-replacement");
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let hook = EthereumMerkleTreeHook::new(
            Arc::new(provider),
            &ContractLocator {
                domain: &domain,
                address: H256::zero(),
            },
        );
        let reorg_period = ReorgPeriod::from_blocks(5);
        let roots = [H256::repeat_byte(1), H256::repeat_byte(2)];

        for (iteration, root) in roots.into_iter().enumerate() {
            mock.push::<Bytes, _>(Bytes::from(encode(&[Token::Uint(1_u64.into())])))
                .expect("enqueue count");
            if iteration == 0 {
                // Mock responses are consumed in reverse insertion order.
                mock.push(U64::from(100)).expect("enqueue tip");
            }
            assert_eq!(hook.count(&reorg_period).await.expect("read count"), 1);
            mock.push::<Bytes, _>(Bytes::from(encode(&[
                Token::FixedBytes(root.as_bytes().to_vec()),
                Token::Uint(0_u64.into()),
            ])))
            .expect("enqueue checkpoint");
            let checkpoint = hook
                .latest_checkpoint(&reorg_period)
                .await
                .expect("read checkpoint");
            assert_eq!(checkpoint.root, root);
            assert_eq!(checkpoint.index, 0);
            assert_eq!(checkpoint.block_height, Some(95));
        }
    }

    #[tokio::test]
    async fn hook_builder_keeps_concrete_endpoint_observations_independent() {
        // Same hostname, distinct full URLs: never collapse quorum endpoints by host.
        let (first, first_mock) = cached_provider("http://localhost/hook-quorum/first");
        let (second, second_mock) = cached_provider("http://localhost/hook-quorum/second");
        first_mock.push(U64::from(100)).expect("first endpoint tip");
        second_mock
            .push(U64::from(99))
            .expect("second endpoint tip");

        for _ in 0..2 {
            assert_eq!(
                first.get_block_number().await.expect("first tip"),
                100.into()
            );
            assert_eq!(
                second.get_block_number().await.expect("second tip"),
                99.into()
            );
        }
    }

    #[tokio::test]
    async fn hook_builder_refreshes_tip_after_production_cache_ttl() {
        let (provider, mock) = cached_provider("http://localhost/hook-production-ttl");
        mock.push(U64::from(100)).expect("initial tip");
        assert_eq!(
            provider.get_block_number().await.expect("initial tip"),
            100.into()
        );
        assert_eq!(
            provider.get_block_number().await.expect("cached tip"),
            100.into()
        );

        tokio::time::sleep(Duration::from_millis(260)).await;
        mock.push(U64::from(99)).expect("replacement tip");
        assert_eq!(
            provider.get_block_number().await.expect("fresh tip"),
            99.into()
        );
    }
}
