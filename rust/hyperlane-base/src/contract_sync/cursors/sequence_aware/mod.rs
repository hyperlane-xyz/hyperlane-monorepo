use std::{fmt::Debug, sync::Arc, time::Duration};

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractSyncCursor, ContractSyncCursorNew, CursorAction,
    HyperlaneSequenceIndexerStore, IndexMode, LogMeta, SequenceAwareIndexer, Sequenced,
};
use std::ops::RangeInclusive;

mod backward;
mod forward;

use backward::BackwardSequenceAwareSyncCursor;
use forward::ForwardSequenceAwareSyncCursor;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SequenceAwareSyncSnapshot {
    sequence: u32,
    at_block: u32,
}

impl SequenceAwareSyncSnapshot {
    fn next(&self) -> Self {
        Self {
            sequence: self.sequence + 1,
            // It's possible that the next sequence would be in the same block,
            // so we refrain from incrementing the block number and instead
            // accept that we'll end up re-indexing the same block.
            at_block: self.at_block,
        }
    }

    fn previous(&self) -> Self {
        Self {
            sequence: self.sequence.saturating_sub(1),
            // It's possible that the next sequence would be in the same block,
            // so we refrain from incrementing the block number and instead
            // accept that we'll end up re-indexing the same block.
            at_block: self.at_block,
        }
    }
}

#[derive(Debug)]
pub enum SyncDirection {
    Forward,
    Backward,
}

/// A SequenceSyncCursor that syncs forwards in perpetuity.
pub(crate) struct ForwardBackwardSequenceAwareSyncCursor<T> {
    forward: ForwardSequenceAwareSyncCursor<T>,
    backward: BackwardSequenceAwareSyncCursor<T>,
    direction: SyncDirection,
    last_range: RangeInclusive<u32>,
}

impl<T: Sequenced> ForwardBackwardSequenceAwareSyncCursor<T> {
    /// Construct a new contract sync helper.
    pub async fn new(
        latest_sequence_querier: Arc<dyn SequenceAwareIndexer<T>>,
        db: Arc<dyn HyperlaneSequenceIndexerStore<T>>,
        chunk_size: u32,
        mode: IndexMode,
    ) -> Result<Self> {
        let (sequence, tip) = latest_sequence_querier
            .latest_sequence_count_and_tip()
            .await?;
        let sequence = sequence.ok_or(ChainCommunicationError::from_other_str(
            "Failed to query sequence",
        ))?;
        let forward_cursor = ForwardSequenceAwareSyncCursor::new(
            chunk_size,
            latest_sequence_querier.clone(),
            db.clone(),
            // TODO?
            SequenceAwareSyncSnapshot {
                sequence: sequence.saturating_sub(1),
                at_block: tip,
            },
            // TODO?
            SequenceAwareSyncSnapshot {
                sequence,
                at_block: tip,
            },
            None,
            mode,
        );
        let backward_cursor = BackwardSequenceAwareSyncCursor::new(
            chunk_size,
            db.clone(),
            // TODO?
            SequenceAwareSyncSnapshot {
                sequence: sequence.saturating_sub(1),
                at_block: tip,
            },
            // TODO?
            SequenceAwareSyncSnapshot {
                sequence,
                at_block: tip,
            },
            mode,
        );
        Ok(Self {
            forward: forward_cursor,
            backward: backward_cursor,
            direction: SyncDirection::Forward,
            last_range: 0..=0,
        })
    }
}

#[async_trait]
impl<T: Sequenced + Debug> ContractSyncCursor<T> for ForwardBackwardSequenceAwareSyncCursor<T> {
    async fn next_action(&mut self) -> ChainResult<(CursorAction, Duration)> {
        self.forward.fast_forward().await?;
        self.backward.fast_forward().await?;

        // TODO: Proper ETA for backwards sync
        let eta = Duration::from_secs(0);
        // Prioritize forward syncing over backward syncing.
        if let Some(forward_range) = self.forward.get_next_range().await? {
            self.direction = SyncDirection::Forward;
            self.last_range = forward_range.clone();
            return Ok((CursorAction::Query(forward_range), eta));
        }

        if let Some(backward_range) = self.backward.get_next_range().await? {
            self.direction = SyncDirection::Backward;
            self.last_range = backward_range.clone();
            return Ok((CursorAction::Query(backward_range), eta));
        }
        // TODO: Define the sleep time from interval flag
        return Ok((CursorAction::Sleep(Duration::from_secs(5)), eta));
    }

    // TODO
    fn latest_block(&self) -> u32 {
        0
    }

    async fn update(&mut self, logs: Vec<(T, LogMeta)>) -> Result<()> {
        match self.direction {
            SyncDirection::Forward => self.forward.update(logs, self.last_range.clone()).await,
            SyncDirection::Backward => self.backward.update(logs, self.last_range.clone()).await,
        }
    }
}

#[async_trait]
impl<T: Sequenced + Debug> ContractSyncCursorNew<T> for ForwardBackwardSequenceAwareSyncCursor<T> {
    async fn fast_forward(&mut self) -> ChainResult<()> {
        self.forward.fast_forward().await?;
        self.backward.fast_forward().await?;
        Ok(())
    }

    async fn next_action(&mut self) -> ChainResult<(CursorAction, Duration)> {
        // TODO: Proper ETA for backwards sync
        let eta = Duration::from_secs(0);
        // Prioritize forward syncing over backward syncing.
        if let Some(forward_range) = self.forward.get_next_range().await? {
            self.direction = SyncDirection::Forward;
            return Ok((CursorAction::Query(forward_range), eta));
        }

        if let Some(backward_range) = self.backward.get_next_range().await? {
            self.direction = SyncDirection::Backward;
            return Ok((CursorAction::Query(backward_range), eta));
        }
        // TODO: Define the sleep time from interval flag
        return Ok((CursorAction::Sleep(Duration::from_secs(5)), eta));
    }

    // TODO
    fn latest_block(&self) -> u32 {
        0
    }

    async fn update(&mut self, logs: Vec<(T, LogMeta)>, range: RangeInclusive<u32>) -> Result<()> {
        match self.direction {
            SyncDirection::Forward => self.forward.update(logs, range).await,
            SyncDirection::Backward => self.backward.update(logs, range).await,
        }
    }
}
