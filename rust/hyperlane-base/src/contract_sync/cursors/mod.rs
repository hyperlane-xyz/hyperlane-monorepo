use std::{
    fmt::Debug,
    ops::RangeInclusive,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use hyperlane_core::{
    ChainCommunicationError, ContractSyncCursor, CursorAction, HyperlaneWatermarkedLogStore,
    IndexMode, Indexer, LogMeta, SequenceAwareIndexer,
};
use tokio::time::sleep;
use tracing::warn;

use crate::contract_sync::eta_calculator::SyncerEtaCalculator;

pub(crate) mod sequence_aware;

pub(crate) use sequence_aware::{
    ForwardBackwardSequenceAwareSyncCursor, ForwardSequenceAwareSyncCursor,
};

/// Time window for the moving average used in the eta calculator in seconds.
const ETA_TIME_WINDOW: f64 = 2. * 60.;

const MAX_SEQUENCE_RANGE: u32 = 20;

#[derive(Debug, new)]
pub(crate) struct SyncState {
    chunk_size: u32,
    /// The starting block for the cursor
    start_block: u32,
    /// The next block that should be indexed.
    next_block: u32,
    mode: IndexMode,
    /// The next sequence index that the cursor is looking for.
    /// In the EVM, this is used for optimizing indexing,
    /// because it's cheaper to make read calls for the sequence index than
    /// to call `eth_getLogs` with a block range.
    /// In Sealevel, historic queries aren't supported, so the sequence field
    /// is used to query storage in sequence.
    next_sequence: u32,
    direction: SyncDirection,
}

impl SyncState {
    async fn get_next_range(
        &mut self,
        max_sequence: Option<u32>,
        tip: u32,
    ) -> Result<Option<RangeInclusive<u32>>> {
        // We attempt to index a range of blocks that is as large as possible.
        let range = match self.mode {
            IndexMode::Block => self.block_range(tip),
            IndexMode::Sequence => {
                let max_sequence = max_sequence.ok_or_else(|| {
                    ChainCommunicationError::from_other_str(
                        "Sequence indexing requires a max sequence",
                    )
                })?;
                if let Some(range) = self.sequence_range(max_sequence)? {
                    range
                } else {
                    return Ok(None);
                }
            }
        };
        if range.is_empty() {
            return Ok(None);
        }
        Ok(Some(range))
    }

    fn block_range(&self, tip: u32) -> RangeInclusive<u32> {
        let (from, to) = match self.direction {
            SyncDirection::Forward => {
                let from = self.next_block;
                let mut to = from + self.chunk_size;
                to = u32::min(to, tip);
                (from, to)
            }
            SyncDirection::Backward => {
                let to = self.next_block;
                let from = to.saturating_sub(self.chunk_size);
                (from, to)
            }
        };
        from..=to
    }

    /// Returns the next sequence range to index.
    ///
    /// # Arguments
    ///
    /// * `tip` - The current tip of the chain.
    /// * `max_sequence` - The maximum sequence that should be indexed.
    /// `max_sequence` is the exclusive upper bound of the range to be indexed.
    /// (e.g. `0..max_sequence`)
    fn sequence_range(&self, max_sequence: u32) -> Result<Option<RangeInclusive<u32>>> {
        let (from, to) = match self.direction {
            SyncDirection::Forward => {
                let sequence_start = self.next_sequence;
                let mut sequence_end = sequence_start + MAX_SEQUENCE_RANGE;
                if self.next_sequence >= max_sequence {
                    return Ok(None);
                }
                sequence_end = u32::min(sequence_end, max_sequence.saturating_sub(1));
                (sequence_start, sequence_end)
            }
            SyncDirection::Backward => {
                let sequence_end = self.next_sequence;
                let sequence_start = sequence_end.saturating_sub(MAX_SEQUENCE_RANGE);
                (sequence_start, sequence_end)
            }
        };
        Ok(Some(from..=to))
    }

    fn update_range(&mut self, range: RangeInclusive<u32>) {
        match self.direction {
            SyncDirection::Forward => match self.mode {
                IndexMode::Block => {
                    self.next_block = *range.end() + 1;
                }
                IndexMode::Sequence => {
                    self.next_sequence = *range.end() + 1;
                }
            },
            SyncDirection::Backward => match self.mode {
                IndexMode::Block => {
                    self.next_block = range.start().saturating_sub(1);
                }
                IndexMode::Sequence => {
                    self.next_sequence = range.start().saturating_sub(1);
                }
            },
        }
    }
}

#[allow(dead_code)]
#[derive(Debug)]
pub enum SyncDirection {
    Forward,
    Backward,
}

/// Tool for handling the logic of what the next block range that should be
/// queried is and also handling rate limiting. Rate limiting is automatically
/// performed by `next_action`.
pub(crate) struct RateLimitedContractSyncCursor<T> {
    indexer: Arc<dyn SequenceAwareIndexer<T>>,
    db: Arc<dyn HyperlaneWatermarkedLogStore<T>>,
    tip: u32,
    max_sequence: Option<u32>,
    last_tip_update: Instant,
    eta_calculator: SyncerEtaCalculator,
    sync_state: SyncState,
}

impl<T> RateLimitedContractSyncCursor<T> {
    /// Construct a new contract sync helper.
    pub async fn new(
        indexer: Arc<dyn SequenceAwareIndexer<T>>,
        db: Arc<dyn HyperlaneWatermarkedLogStore<T>>,
        chunk_size: u32,
        initial_height: u32,
        mode: IndexMode,
    ) -> Result<Self> {
        let (max_sequence, tip) = indexer.latest_sequence_count_and_tip().await?;
        Ok(Self {
            indexer,
            db,
            tip,
            max_sequence,
            last_tip_update: Instant::now(),
            eta_calculator: SyncerEtaCalculator::new(initial_height, tip, ETA_TIME_WINDOW),
            sync_state: SyncState::new(
                chunk_size,
                initial_height,
                initial_height,
                mode,
                Default::default(),
                // The rate limited cursor currently only syncs in the forward direction.
                SyncDirection::Forward,
            ),
        })
    }

    /// Wait based on how close we are to the tip and update the tip,
    /// i.e. the highest block we may scrape.
    async fn get_rate_limit(&mut self) -> Result<Option<Duration>> {
        if self.sync_state.next_block + self.sync_state.chunk_size < self.tip {
            // If doing the full chunk wouldn't exceed the already known tip we do not need to rate limit.
            Ok(None)
        } else {
            // We are within one chunk size of the known tip.
            // If it's been fewer than 30s since the last tip update, sleep for a bit until we're ready to fetch the next tip.
            if let Some(sleep_time) =
                Duration::from_secs(30).checked_sub(self.last_tip_update.elapsed())
            {
                return Ok(Some(sleep_time));
            }
            match self.indexer.get_finalized_block_number().await {
                Ok(tip) => {
                    // we retrieved a new tip value, go ahead and update.
                    self.last_tip_update = Instant::now();
                    self.tip = tip;
                    Ok(None)
                }
                Err(e) => {
                    warn!(error = %e, "Failed to get next block range because we could not get the current tip");
                    // we are failing to make a basic query, we should wait before retrying.
                    sleep(Duration::from_secs(10)).await;
                    Err(e.into())
                }
            }
        }
    }

    fn sync_end(&self) -> Result<u32> {
        match self.sync_state.mode {
            IndexMode::Block => Ok(self.tip),
            IndexMode::Sequence => self
                .max_sequence
                .ok_or(eyre::eyre!("Sequence indexing requires a max sequence",)),
        }
    }

    fn sync_position(&self) -> u32 {
        match self.sync_state.mode {
            IndexMode::Block => self.sync_state.next_block,
            IndexMode::Sequence => self.sync_state.next_sequence,
        }
    }

    fn sync_step(&self) -> u32 {
        match self.sync_state.mode {
            IndexMode::Block => self.sync_state.chunk_size,
            IndexMode::Sequence => MAX_SEQUENCE_RANGE,
        }
    }

    async fn get_next_range(&mut self) -> Result<Option<RangeInclusive<u32>>> {
        let (max_sequence, tip) = self.indexer.latest_sequence_count_and_tip().await?;
        self.tip = tip;
        self.max_sequence = max_sequence;

        self.sync_state.get_next_range(max_sequence, tip).await
    }

    fn sync_eta(&mut self) -> Result<Duration> {
        let sync_end = self.sync_end()?;
        let to = u32::min(sync_end, self.sync_position() + self.sync_step());
        let from = self.sync_position();
        let eta = if to < sync_end {
            self.eta_calculator.calculate(from, sync_end)
        } else {
            Duration::from_secs(0)
        };
        Ok(eta)
    }
}

#[async_trait]
impl<T> ContractSyncCursor<T> for RateLimitedContractSyncCursor<T>
where
    T: Send + Debug + 'static,
{
    async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
        let eta = self.sync_eta()?;

        let rate_limit = self.get_rate_limit().await?;
        if let Some(rate_limit) = rate_limit {
            return Ok((CursorAction::Sleep(rate_limit), eta));
        }

        if let Some(range) = self.get_next_range().await? {
            return Ok((CursorAction::Query(range), eta));
        } else {
            // TODO: Define the sleep time from interval flag
            return Ok((CursorAction::Sleep(Duration::from_secs(5)), eta));
        }
    }

    fn latest_queried_block(&self) -> u32 {
        self.sync_state.next_block.saturating_sub(1)
    }

    async fn update(&mut self, _: Vec<(T, LogMeta)>, range: RangeInclusive<u32>) -> Result<()> {
        // Store a relatively conservative view of the high watermark, which should allow a single watermark to be
        // safely shared across multiple cursors, so long as they are running sufficiently in sync
        self.db
            .store_high_watermark(u32::max(
                self.sync_state.start_block,
                self.sync_state
                    .next_block
                    .saturating_sub(self.sync_state.chunk_size),
            ))
            .await?;
        self.sync_state.update_range(range);
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod test {
    use super::*;
    use hyperlane_core::{ChainResult, HyperlaneLogStore};
    use mockall::{self, Sequence};

    const CHUNK_SIZE: u32 = 10;
    const INITIAL_HEIGHT: u32 = 0;

    mockall::mock! {
        pub Indexer {}

        impl Debug for Indexer {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        #[async_trait]
        impl Indexer<()> for Indexer {
            async fn fetch_logs(&self, range: RangeInclusive<u32>) -> ChainResult<Vec<((), LogMeta)>>;
            async fn get_finalized_block_number(&self) -> ChainResult<u32>;
        }

        #[async_trait]
        impl SequenceAwareIndexer<()> for Indexer {
            async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)>;
        }
    }

    mockall::mock! {
        pub Db {}

        impl Debug for Db {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        #[async_trait]
        impl HyperlaneLogStore<()> for Db {
            async fn store_logs(&self, logs: &[((), LogMeta)]) -> Result<u32>;
        }

        #[async_trait]
        impl HyperlaneWatermarkedLogStore<()> for Db {
            async fn retrieve_high_watermark(&self) -> Result<Option<u32>>;
            async fn store_high_watermark(&self, block_number: u32) -> Result<()>;
        }
    }

    async fn mock_rate_limited_cursor(
        custom_chain_tips: Option<Vec<u32>>,
    ) -> RateLimitedContractSyncCursor<()> {
        let mut seq = Sequence::new();
        let mut indexer = MockIndexer::new();
        match custom_chain_tips {
            Some(chain_tips) => {
                for tip in chain_tips {
                    indexer
                        .expect_latest_sequence_count_and_tip()
                        .times(1)
                        .in_sequence(&mut seq)
                        .returning(move || Ok((None, tip)));
                }
            }
            None => {
                indexer
                    .expect_latest_sequence_count_and_tip()
                    .returning(move || Ok((None, 100)));
            }
        }

        let mut db = MockDb::new();
        db.expect_store_high_watermark().returning(|_| Ok(()));
        let chunk_size = CHUNK_SIZE;
        let initial_height = INITIAL_HEIGHT;
        let mode = IndexMode::Block;
        RateLimitedContractSyncCursor::new(
            Arc::new(indexer),
            Arc::new(db),
            chunk_size,
            initial_height,
            mode,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn test_next_action_retries_if_update_isnt_called() {
        let mut cursor = mock_rate_limited_cursor(None).await;
        let (action_1, _) = cursor.next_action().await.unwrap();
        let (action_2, _) = cursor.next_action().await.unwrap();

        // Calling next_action without updating the cursor should return the same action
        assert!(matches!(action_1, action_2));
    }

    #[tokio::test]
    async fn test_next_action_changes_if_update_is_called() {
        let mut cursor = mock_rate_limited_cursor(None).await;
        let (action_1, _) = cursor.next_action().await.unwrap();

        let range = match action_1 {
            CursorAction::Query(range) => range,
            _ => panic!("Expected Query action"),
        };
        cursor.update(vec![], range.clone()).await.unwrap();

        let (action_3, _) = cursor.next_action().await.unwrap();
        let expected_range = range.end() + 1..=(range.end() + CHUNK_SIZE);
        assert!(matches!(action_3, CursorAction::Query(expected_range)));
    }

    #[tokio::test]
    async fn test_next_action_sleeps_if_tip_is_not_updated() {
        let chain_tips = vec![10];
        let mut cursor = mock_rate_limited_cursor(Some(chain_tips)).await;
        let (action, _) = cursor.next_action().await.unwrap();
        assert!(matches!(action, CursorAction::Sleep(_)));
    }
}
