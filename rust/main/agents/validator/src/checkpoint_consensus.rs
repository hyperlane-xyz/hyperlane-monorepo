//! Independent finality-aware checkpoint reads for every validator indexing mode.

use std::{sync::Arc, time::Duration};

use futures_util::{stream::BoxStream, StreamExt};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, CheckpointAtBlock, MerkleTreeHook, ReorgPeriod,
};
use tokio::time::timeout;

const RPC_TIMEOUT: Duration = Duration::from_secs(20);

/// Validator checkpoint agreement, independent of the protocol's RPC transport.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CheckpointConsensus {
    /// Existing ethers quorum threshold: ceil(N/2), including ties for even pools.
    Quorum,
    /// At least two thirds of the configured endpoint pool.
    Majority,
}

impl CheckpointConsensus {
    pub(crate) fn required(self, endpoint_count: usize) -> usize {
        assert!(
            endpoint_count > 0,
            "checkpoint endpoint pool must not be empty"
        );
        match self {
            Self::Quorum => endpoint_count.div_ceil(2),
            Self::Majority => endpoint_count
                .checked_sub(endpoint_count / 3)
                .expect("a third cannot exceed the endpoint count"),
        }
    }
}

/// Every configured state-read endpoint keeps a slot in the checkpoint vote.
#[derive(Debug)]
pub(crate) struct CheckpointReader {
    hooks: Vec<Arc<dyn MerkleTreeHook>>,
    pub(crate) consensus: CheckpointConsensus,
}

impl CheckpointReader {
    pub(crate) fn new(
        consensus: CheckpointConsensus,
        hooks: Vec<Arc<dyn MerkleTreeHook>>,
    ) -> ChainResult<Self> {
        if hooks.is_empty() {
            return Err(ChainCommunicationError::from_other_str(
                "Checkpoint consensus requires at least one state-read endpoint",
            ));
        }
        Ok(Self { hooks, consensus })
    }

    /// Preserve one slot per configured endpoint, including failures, so retries
    /// cannot shrink the voting denominator or mix up endpoint identities.
    /// Each adapter applies its existing confirmation/finality policy.
    #[cfg(test)]
    pub(crate) async fn checkpoints(
        &self,
        period: &ReorgPeriod,
    ) -> ChainResult<Vec<Option<CheckpointAtBlock>>> {
        let mut checkpoints = vec![None; self.hooks.len()];
        let mut stream = self.checkpoint_stream(period);
        while let Some((slot, checkpoint)) = stream.next().await {
            checkpoints[slot] = checkpoint;
        }
        if checkpoints.iter().flatten().count() < self.consensus.required(self.hooks.len()) {
            return Err(ChainCommunicationError::from_other_str(
                "Insufficient checkpoint responses for configured agreement",
            ));
        }
        Ok(checkpoints)
    }
    pub(crate) fn endpoint_count(&self) -> usize {
        self.hooks.len()
    }

    pub(crate) fn checkpoint_stream<'a>(
        &'a self,
        period: &'a ReorgPeriod,
    ) -> BoxStream<'a, (usize, Option<CheckpointAtBlock>)> {
        futures_util::stream::iter(self.hooks.iter().enumerate().map(
            move |(endpoint_index, hook)| async move {
                let checkpoint = match timeout(RPC_TIMEOUT, hook.latest_checkpoint(period)).await {
                    Ok(Ok(checkpoint)) => {
                        tracing::debug!(
                            endpoint_index,
                            ?checkpoint,
                            "Read consensus endpoint checkpoint"
                        );
                        Some(checkpoint)
                    }
                    Ok(Err(_)) => {
                        tracing::warn!(endpoint_index, "Consensus checkpoint RPC failed");
                        None
                    }
                    Err(_) => {
                        tracing::warn!(endpoint_index, "Consensus checkpoint RPC timed out");
                        None
                    }
                };
                (endpoint_index, checkpoint)
            },
        ))
        .buffer_unordered(self.hooks.len())
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::mock_merkle_tree_hook::MockMerkleTreeHook;
    use hyperlane_core::{Checkpoint, H256};
    use mockall::predicate::eq;

    fn checkpoint(index: u32) -> CheckpointAtBlock {
        CheckpointAtBlock {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: H256::from_low_u64_be(10),
                mailbox_domain: 1,
                root: H256::from_low_u64_be(u64::from(index)),
                index,
            },
            block_height: None,
        }
    }

    #[test]
    fn threshold_rounds_up_two_thirds() {
        for (endpoints, required) in [(1, 1), (2, 2), (3, 2), (4, 3), (5, 4), (6, 4), (7, 5)] {
            assert_eq!(CheckpointConsensus::Majority.required(endpoints), required);
        }
    }

    #[test]
    fn quorum_preserves_existing_half_threshold() {
        for (endpoints, required) in [(1, 1), (2, 1), (3, 2), (4, 2), (5, 3), (6, 3), (7, 4)] {
            assert_eq!(CheckpointConsensus::Quorum.required(endpoints), required);
        }
    }

    #[tokio::test]
    async fn failed_endpoints_keep_their_slots_and_the_original_threshold() {
        for failed in [1, 2] {
            let hooks = (0..4)
                .map(|index| {
                    let mut hook = MockMerkleTreeHook::new();
                    hook.expect_latest_checkpoint()
                        .once()
                        .return_once(move |_| {
                            if index < failed {
                                Err(ChainCommunicationError::from_other_str("unavailable"))
                            } else {
                                Ok(checkpoint(index))
                            }
                        });
                    Arc::new(hook) as Arc<dyn MerkleTreeHook>
                })
                .collect();
            let reader =
                CheckpointReader::new(CheckpointConsensus::Majority, hooks).expect("endpoints");
            let result = reader.checkpoints(&ReorgPeriod::None).await;
            if failed == 1 {
                let checkpoints = result.expect("three of four responses");
                assert_eq!(checkpoints.len(), 4);
                assert!(checkpoints[0].is_none());
                assert_eq!(checkpoints[1].as_ref().expect("second endpoint").index, 1);
            } else {
                assert!(result.is_err(), "two of four must not become two of two");
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_minority_is_bounded_and_does_not_block_agreement() {
        let mut hooks: Vec<Arc<dyn MerkleTreeHook>> = vec![Arc::new(StalledHook)];
        for index in 0..2 {
            let mut hook = MockMerkleTreeHook::new();
            hook.expect_latest_checkpoint()
                .once()
                .return_once(move |_| Ok(checkpoint(index)));
            hooks.push(Arc::new(hook));
        }
        let reader =
            CheckpointReader::new(CheckpointConsensus::Majority, hooks).expect("endpoints");
        let started = tokio::time::Instant::now();
        let checkpoints = reader
            .checkpoints(&ReorgPeriod::None)
            .await
            .expect("two of three");
        assert_eq!(started.elapsed(), RPC_TIMEOUT);
        assert_eq!(checkpoints.len(), 3);
        assert!(checkpoints[0].is_none());
    }

    #[tokio::test]
    async fn reads_each_endpoint_once_with_its_own_finality_state() {
        for period in [
            ReorgPeriod::None,
            ReorgPeriod::from_blocks(15),
            ReorgPeriod::Tag("finalized".into()),
        ] {
            let hooks = (0..3)
                .map(|index| {
                    let mut hook = MockMerkleTreeHook::new();
                    hook.expect_latest_checkpoint()
                        .with(eq(period.clone()))
                        .once()
                        .return_once(move |_| Ok(checkpoint(index)));
                    Arc::new(hook) as Arc<dyn MerkleTreeHook>
                })
                .collect();
            let reader =
                CheckpointReader::new(CheckpointConsensus::Majority, hooks).expect("endpoints");
            let checkpoints = reader.checkpoints(&period).await.expect("checkpoints");
            assert_eq!(
                checkpoints
                    .iter()
                    .flatten()
                    .map(|c| c.index)
                    .collect::<Vec<_>>(),
                vec![0, 1, 2]
            );
        }
    }

    #[tokio::test]
    async fn unavailable_endpoint_blocks_then_recovers_without_shrinking_pool() {
        let mut first = MockMerkleTreeHook::new();
        first
            .expect_latest_checkpoint()
            .times(2)
            .returning(|_| Ok(checkpoint(0)));
        let mut other = MockMerkleTreeHook::new();
        let mut sequence = mockall::Sequence::new();
        other
            .expect_latest_checkpoint()
            .once()
            .in_sequence(&mut sequence)
            .return_once(|_| Err(ChainCommunicationError::from_other_str("unavailable")));
        other
            .expect_latest_checkpoint()
            .once()
            .in_sequence(&mut sequence)
            .return_once(|_| Ok(checkpoint(1)));
        let reader = CheckpointReader::new(
            CheckpointConsensus::Majority,
            vec![Arc::new(first), Arc::new(other)],
        )
        .expect("endpoints");
        assert!(reader.checkpoints(&ReorgPeriod::None).await.is_err());
        assert_eq!(
            reader
                .checkpoints(&ReorgPeriod::None)
                .await
                .expect("recovered")
                .len(),
            2
        );
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_endpoint_times_out() {
        let reader =
            CheckpointReader::new(CheckpointConsensus::Majority, vec![Arc::new(StalledHook)])
                .expect("endpoint");
        let started = tokio::time::Instant::now();
        assert!(reader.checkpoints(&ReorgPeriod::None).await.is_err());
        assert_eq!(started.elapsed(), RPC_TIMEOUT);
    }

    #[derive(Debug)]
    struct StalledHook;
    impl hyperlane_core::HyperlaneChain for StalledHook {
        fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
            unreachable!()
        }
        fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
            unreachable!()
        }
    }
    impl hyperlane_core::HyperlaneContract for StalledHook {
        fn address(&self) -> H256 {
            unreachable!()
        }
    }
    #[async_trait::async_trait]
    impl MerkleTreeHook for StalledHook {
        async fn tree(
            &self,
            _: &ReorgPeriod,
        ) -> ChainResult<hyperlane_core::IncrementalMerkleAtBlock> {
            unreachable!()
        }
        async fn count(&self, _: &ReorgPeriod) -> ChainResult<u32> {
            unreachable!()
        }
        async fn latest_checkpoint(&self, _: &ReorgPeriod) -> ChainResult<CheckpointAtBlock> {
            std::future::pending().await
        }
        async fn latest_checkpoint_at_block(&self, _: u64) -> ChainResult<CheckpointAtBlock> {
            unreachable!()
        }
    }

    #[test]
    fn empty_pool_is_rejected() {
        assert!(CheckpointReader::new(CheckpointConsensus::Majority, vec![]).is_err());
    }
}
