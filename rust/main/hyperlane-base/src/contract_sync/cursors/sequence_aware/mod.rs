use std::ops::RangeInclusive;
use std::{fmt::Debug, sync::Arc, time::Duration};

use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{
    ChainCommunicationError, ContractSyncCursor, CursorAction, HyperlaneDomain,
    HyperlaneSequenceAwareIndexerStoreReader, IndexMode, Indexed, LogMeta, SequenceAwareIndexer,
};

mod backward;
mod forward;

pub(crate) use backward::BackwardSequenceAwareSyncCursor;
pub(crate) use forward::ForwardSequenceAwareSyncCursor;

use crate::cursors::sequence_aware::backward::BackwardSequenceAwareSyncCursorParams;

use super::{CursorMetrics, Indexable};

#[derive(Debug, Clone, PartialEq, Eq)]
struct LastIndexedSnapshot {
    /// The last sequence that was indexed.
    /// It's possible for this to be None if nothing has been indexed yet
    /// e.g. upon first starting up or if no sequenced data exists yet.
    pub sequence: Option<u32>,
    /// The block number at which the last sequence was indexed.
    /// If the sequence is None, this can be thought of as the starting block
    /// number to index from.
    pub at_block: u32,
}

/// Used to avoid going over the `instrument` macro limit.
#[derive(Debug, Clone)]
pub struct MetricsData {
    pub domain: HyperlaneDomain,
    pub metrics: Arc<CursorMetrics>,
}

impl LastIndexedSnapshot {
    fn next_target(&self) -> TargetSnapshot {
        TargetSnapshot {
            // If we haven't indexed anything yet, we start at 0, otherwise we increment.
            sequence: self.sequence.map(|s| s + 1).unwrap_or(0),
            at_block: self.at_block,
        }
    }

    fn previous_target(&self) -> Option<TargetSnapshot> {
        match &self.sequence {
            // A previous target doesn't exist if we're trying to go backward
            // from sequence 0 or if nothing has been indexed yet.
            Some(0) | None => None,
            Some(s) => Some(TargetSnapshot {
                sequence: s.saturating_sub(1),
                at_block: self.at_block,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TargetSnapshot {
    pub sequence: u32,
    pub at_block: u32,
}

#[derive(Debug)]
pub enum SyncDirection {
    Forward,
    Backward,
}

/// A cursor that prefers to sync forward, but will sync backward if there is nothing to
/// sync forward.
#[derive(Debug)]
pub(crate) struct ForwardBackwardSequenceAwareSyncCursor<T> {
    forward: ForwardSequenceAwareSyncCursor<T>,
    backward: BackwardSequenceAwareSyncCursor<T>,
    last_direction: SyncDirection,
}

impl<T: Debug + Indexable + Clone + Sync + Send + 'static>
    ForwardBackwardSequenceAwareSyncCursor<T>
{
    /// Construct a new contract sync helper.
    pub async fn new(
        domain: &HyperlaneDomain,
        metrics: Arc<CursorMetrics>,
        latest_sequence_querier: Arc<dyn SequenceAwareIndexer<T>>,
        store: Arc<dyn HyperlaneSequenceAwareIndexerStoreReader<T>>,
        chunk_size: u32,
        lowest_block_height_or_sequence: i64,
        mode: IndexMode,
    ) -> Result<Self> {
        let (sequence_count, tip) = latest_sequence_querier
            .latest_sequence_count_and_tip()
            .await?;
        let sequence_count = sequence_count.ok_or(ChainCommunicationError::from_other_str(
            "Failed to query sequence",
        ))?;
        let metrics_data = MetricsData {
            domain: domain.to_owned(),
            metrics,
        };
        let forward_cursor = ForwardSequenceAwareSyncCursor::new(
            chunk_size,
            latest_sequence_querier.clone(),
            store.clone(),
            sequence_count,
            tip,
            mode,
            metrics_data.clone(),
        );

        let params = BackwardSequenceAwareSyncCursorParams {
            chunk_size,
            latest_sequence_querier: latest_sequence_querier.clone(),
            lowest_block_height_or_sequence,
            store,
            current_sequence_count: sequence_count,
            start_block: tip,
            index_mode: mode,
            metrics_data,
        };
        let backward_cursor = BackwardSequenceAwareSyncCursor::new(params);
        Ok(Self {
            forward: forward_cursor,
            backward: backward_cursor,
            last_direction: SyncDirection::Forward,
        })
    }
}

#[async_trait]
impl<T: Send + Sync + Clone + Debug + 'static + Indexable> ContractSyncCursor<T>
    for ForwardBackwardSequenceAwareSyncCursor<T>
{
    async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
        // TODO: Proper ETA for backwards sync
        let eta = Duration::from_secs(0);
        // Prioritize forward syncing over backward syncing.
        if let Some(forward_range) = self.forward.get_next_range().await? {
            self.last_direction = SyncDirection::Forward;
            return Ok((CursorAction::Query(forward_range), eta));
        }

        if let Some(backward_range) = self.backward.get_next_range().await? {
            self.last_direction = SyncDirection::Backward;
            return Ok((CursorAction::Query(backward_range), eta));
        }
        // TODO: Define the sleep time from interval flag
        return Ok((CursorAction::Sleep(Duration::from_secs(5)), eta));
    }

    fn latest_queried_block(&self) -> u32 {
        self.forward.latest_queried_block()
    }

    async fn update(
        &mut self,
        logs: Vec<(Indexed<T>, LogMeta)>,
        range: RangeInclusive<u32>,
    ) -> Result<()> {
        match self.last_direction {
            SyncDirection::Forward => self.forward.update(logs, range).await,
            SyncDirection::Backward => self.backward.update(logs, range).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fmt::Debug, ops::RangeInclusive, sync::Arc};

    use hyperlane_core::{
        ChainResult, HyperlaneDomain, HyperlaneLogStore, HyperlaneSequenceAwareIndexerStoreReader,
        HyperlaneWatermarkedLogStore, IndexMode, Indexed, Indexer, KnownHyperlaneDomain, LogMeta,
        SequenceAwareIndexer, H256, H512,
    };

    use crate::cursors::{CursorMetrics, ForwardBackwardSequenceAwareSyncCursor, Indexable};

    mockall::mock! {
        pub Db<T: Indexable + Send + Sync> {}

        impl<T: Indexable + Send + Sync> Debug for Db<T> {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        #[async_trait::async_trait]
        impl<T: Indexable + Send + Sync> HyperlaneLogStore<T> for Db<T> {
            async fn store_logs(&self, logs: &[(hyperlane_core::Indexed<T>, LogMeta)]) -> eyre::Result<u32>;
        }

        #[async_trait::async_trait]
        impl<T: Indexable + Send + Sync> HyperlaneWatermarkedLogStore<T> for Db<T> {
            async fn retrieve_high_watermark(&self) -> eyre::Result<Option<u32>>;
            async fn store_high_watermark(&self, block_number: u32) -> eyre::Result<()>;
        }

        #[async_trait::async_trait]
        impl<T: Indexable + Send + Sync> HyperlaneSequenceAwareIndexerStoreReader<T> for Db<T> {
            async fn retrieve_by_sequence(&self, sequence: u32) -> eyre::Result<Option<T>>;
            async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> eyre::Result<Option<u64>>;
        }
    }

    mockall::mock! {
        #[auto_impl::auto_impl(&, Box, Arc)]
        #[derive(Clone, Debug)]
        pub SequenceAwareIndexerMock<T> {}

        #[async_trait::async_trait]
        impl<T: Indexable + Send + Sync> Indexer<T> for SequenceAwareIndexerMock<T> {
            async fn fetch_logs_in_range(
                &self,
                range: RangeInclusive<u32>,
            ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>>;

            async fn get_finalized_block_number(&self) -> ChainResult<u32>;

            async fn fetch_logs_by_tx_hash(
                &self,
                _tx_hash: H512,
            ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>>;
        }

        #[async_trait::async_trait]
        impl<T: Indexable + Send + Sync> SequenceAwareIndexer<T> for SequenceAwareIndexerMock<T> {
            async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)>;
        }
    }

    fn mock_cursor_metrics() -> CursorMetrics {
        CursorMetrics {
            cursor_current_block: prometheus::IntGaugeVec::new(
                prometheus::Opts::new("cursor_current_block", "Current block of the cursor")
                    .namespace("mock")
                    .subsystem("cursor"),
                &["event_type", "chain", "cursor_type"],
            )
            .unwrap(),
            cursor_current_sequence: prometheus::IntGaugeVec::new(
                prometheus::Opts::new("cursor_current_sequence", "Current sequence of the cursor")
                    .namespace("mock")
                    .subsystem("cursor"),
                &["event_type", "chain", "cursor_type"],
            )
            .unwrap(),
            cursor_max_sequence: prometheus::IntGaugeVec::new(
                prometheus::Opts::new("cursor_max_sequence", "Max sequence of the cursor")
                    .namespace("mock")
                    .subsystem("cursor"),
                &["event_type", "chain"],
            )
            .unwrap(),
        }
    }

    #[tokio::test]
    async fn test_relative_block_height_or_sequence() {
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);

        let metrics = mock_cursor_metrics();

        let mut sequencer = MockSequenceAwareIndexerMock::new();

        sequencer
            .expect_latest_sequence_count_and_tip()
            .returning(|| Ok((Some(100), 100)));

        let latest_sequence_querier = Arc::new(sequencer);
        let mut store = MockDb::new();

        store.expect_retrieve_by_sequence().returning(|_| Ok(None));
        store
            .expect_retrieve_log_block_number_by_sequence()
            .returning(|_| Ok(None));

        let chunk_size = 20;
        let lowest_block_height_or_sequence: i64 = -10;
        let mode = IndexMode::Sequence;

        let store_arc: Arc<dyn HyperlaneSequenceAwareIndexerStoreReader<H256>> = Arc::new(store);

        let cursor = ForwardBackwardSequenceAwareSyncCursor::new(
            &domain,
            Arc::new(metrics),
            latest_sequence_querier,
            store_arc,
            chunk_size,
            lowest_block_height_or_sequence,
            mode,
        )
        .await
        .expect("Failed to instantiate ForwardBackwardSequenceAwareSyncCursor");

        assert_eq!(
            cursor.backward.lowest_block_height_or_sequence,
            lowest_block_height_or_sequence
        );
    }
}
