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
struct MetricsData {
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
        lowest_block_height_or_sequence: u32,
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
        let backward_cursor = BackwardSequenceAwareSyncCursor::new(
            chunk_size,
            lowest_block_height_or_sequence,
            store,
            sequence_count,
            tip,
            mode,
            metrics_data,
        );
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
