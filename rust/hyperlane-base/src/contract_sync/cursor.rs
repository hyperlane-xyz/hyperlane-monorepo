use std::{
    cmp::Ordering,
    fmt::Debug,
    ops::RangeInclusive,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractSyncCursor, CursorAction, HyperlaneMessage,
    HyperlaneMessageStore, HyperlaneWatermarkedLogStore, IndexMode, Indexer, LogMeta,
    SequenceIndexer,
};
use tokio::time::sleep;
use tracing::{debug, warn};

use crate::contract_sync::eta_calculator::SyncerEtaCalculator;

/// Time window for the moving average used in the eta calculator in seconds.
const ETA_TIME_WINDOW: f64 = 2. * 60.;

const MAX_SEQUENCE_RANGE: u32 = 100;

/// A struct that holds the data needed for forwards and backwards
/// message sync cursors.
#[derive(Debug, new)]
pub(crate) struct MessageSyncCursor {
    indexer: Arc<dyn SequenceIndexer<HyperlaneMessage>>,
    db: Arc<dyn HyperlaneMessageStore>,
    sync_state: SyncState,
}

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
    ) -> ChainResult<Option<RangeInclusive<u32>>> {
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

    fn block_range(&mut self, tip: u32) -> RangeInclusive<u32> {
        let (from, to) = match self.direction {
            SyncDirection::Forward => {
                let from = self.next_block;
                let mut to = from + self.chunk_size;
                to = u32::min(to, tip);
                self.next_block = to + 1;
                (from, to)
            }
            SyncDirection::Backward => {
                let to = self.next_block;
                let from = to.saturating_sub(self.chunk_size);
                self.next_block = from.saturating_sub(1);
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
    fn sequence_range(&mut self, max_sequence: u32) -> ChainResult<Option<RangeInclusive<u32>>> {
        let (from, to) = match self.direction {
            SyncDirection::Forward => {
                let sequence_start = self.next_sequence;
                let mut sequence_end = sequence_start + MAX_SEQUENCE_RANGE;
                if self.next_sequence >= max_sequence {
                    return Ok(None);
                }
                sequence_end = u32::min(sequence_end, max_sequence.saturating_sub(1));
                self.next_sequence = sequence_end + 1;
                (sequence_start, sequence_end)
            }
            SyncDirection::Backward => {
                let sequence_end = self.next_sequence;
                let sequence_start = sequence_end.saturating_sub(MAX_SEQUENCE_RANGE);
                self.next_sequence = sequence_start.saturating_sub(1);
                (sequence_start, sequence_end)
            }
        };
        Ok(Some(from..=to))
    }
}

impl MessageSyncCursor {
    async fn retrieve_message_by_nonce(&self, nonce: u32) -> Option<HyperlaneMessage> {
        if let Ok(Some(message)) = self.db.retrieve_message_by_nonce(nonce).await {
            Some(message)
        } else {
            None
        }
    }

    async fn retrieve_dispatched_block_number(&self, nonce: u32) -> Option<u32> {
        if let Ok(Some(block_number)) = self.db.retrieve_dispatched_block_number(nonce).await {
            Some(u32::try_from(block_number).unwrap())
        } else {
            None
        }
    }

    async fn update(
        &mut self,
        logs: Vec<(HyperlaneMessage, LogMeta)>,
        prev_sequence: u32,
    ) -> Result<()> {
        // If we found messages, but did *not* find the message we were looking for,
        // we need to rewind to the block at which we found the last message.
        if !logs.is_empty()
            && !logs
                .iter()
                .any(|m| m.0.nonce == self.sync_state.next_sequence)
        {
            warn!(next_nonce=?self.sync_state.next_sequence, "Target nonce not found, rewinding");
            // If the previous nonce has been synced, rewind to the block number
            // at which it was dispatched. Otherwise, rewind all the way back to the start block.
            if let Some(block_number) = self.retrieve_dispatched_block_number(prev_sequence).await {
                self.sync_state.next_block = block_number;
                warn!(block_number, "Rewound to previous known message");
            } else {
                self.sync_state.next_block = self.sync_state.start_block;
            }
            Ok(())
        } else {
            Ok(())
        }
    }
}

/// A MessageSyncCursor that syncs forwards in perpetuity.
pub(crate) struct ForwardMessageSyncCursor {
    cursor: MessageSyncCursor,
}

impl ForwardMessageSyncCursor {
    pub fn new(
        indexer: Arc<dyn SequenceIndexer<HyperlaneMessage>>,
        db: Arc<dyn HyperlaneMessageStore>,
        chunk_size: u32,
        start_block: u32,
        next_block: u32,
        mode: IndexMode,
        next_sequence: u32,
    ) -> Self {
        Self {
            cursor: MessageSyncCursor::new(
                indexer,
                db,
                SyncState::new(
                    chunk_size,
                    start_block,
                    next_block,
                    mode,
                    next_sequence,
                    SyncDirection::Forward,
                ),
            ),
        }
    }

    async fn get_next_range(&mut self) -> ChainResult<Option<RangeInclusive<u32>>> {
        // Check if any new messages have been inserted into the DB,
        // and update the cursor accordingly.
        while self
            .cursor
            .retrieve_message_by_nonce(self.cursor.sync_state.next_sequence)
            .await
            .is_some()
        {
            if let Some(block_number) = self
                .cursor
                .retrieve_dispatched_block_number(self.cursor.sync_state.next_sequence)
                .await
            {
                debug!(next_block = block_number, "Fast forwarding next block");
                // It's possible that eth_getLogs dropped logs from this block, therefore we cannot do block_number + 1.
                self.cursor.sync_state.next_block = block_number;
            }
            debug!(
                next_nonce = self.cursor.sync_state.next_sequence + 1,
                "Fast forwarding next nonce"
            );
            self.cursor.sync_state.next_sequence += 1;
        }

        let (Some(mailbox_count), tip) = self.cursor.indexer.sequence_and_tip().await? else {
            return Ok(None);
        };
        let cursor_count = self.cursor.sync_state.next_sequence;
        Ok(match cursor_count.cmp(&mailbox_count) {
            Ordering::Equal => {
                // We are synced up to the latest nonce so we don't need to index anything.
                // We update our next block number accordingly.
                self.cursor.sync_state.next_block = tip;
                None
            }
            Ordering::Less => {
                // The cursor is behind the mailbox, so we need to index some blocks.
                self.cursor
                    .sync_state
                    .get_next_range(Some(mailbox_count), tip)
                    .await?
            }
            Ordering::Greater => {
                // Providers may be internally inconsistent, e.g. RPC request A could hit a node
                // whose tip is N and subsequent RPC request B could hit a node whose tip is < N.
                debug!("Cursor count is greater than Mailbox count");
                None
            }
        })
    }
}

#[async_trait]
impl ContractSyncCursor<HyperlaneMessage> for ForwardMessageSyncCursor {
    async fn next_action(&mut self) -> ChainResult<(CursorAction, Duration)> {
        // TODO: Fix ETA calculation
        let eta = Duration::from_secs(0);
        if let Some(range) = self.get_next_range().await? {
            Ok((CursorAction::Query(range), eta))
        } else {
            // TODO: Define the sleep time from interval flag
            Ok((CursorAction::Sleep(Duration::from_secs(5)), eta))
        }
    }

    fn latest_block(&self) -> u32 {
        self.cursor.sync_state.next_block.saturating_sub(1)
    }

    /// If the previous block has been synced, rewind to the block number
    /// at which it was dispatched.
    /// Otherwise, rewind all the way back to the start block.
    async fn update(&mut self, logs: Vec<(HyperlaneMessage, LogMeta)>) -> Result<()> {
        let prev_nonce = self.cursor.sync_state.next_sequence.saturating_sub(1);
        // We may wind up having re-indexed messages that are previous to the nonce that we are looking for.
        // We should not consider these messages when checking for continuity errors.
        let filtered_logs = logs
            .into_iter()
            .filter(|m| m.0.nonce >= self.cursor.sync_state.next_sequence)
            .collect();
        self.cursor.update(filtered_logs, prev_nonce).await
    }
}

/// A MessageSyncCursor that syncs backwards to sequence (nonce) zero.
pub(crate) struct BackwardMessageSyncCursor {
    cursor: MessageSyncCursor,
    synced: bool,
}

impl BackwardMessageSyncCursor {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        indexer: Arc<dyn SequenceIndexer<HyperlaneMessage>>,
        db: Arc<dyn HyperlaneMessageStore>,
        chunk_size: u32,
        start_block: u32,
        next_block: u32,
        mode: IndexMode,
        next_sequence: u32,
        synced: bool,
    ) -> Self {
        Self {
            cursor: MessageSyncCursor::new(
                indexer,
                db,
                SyncState::new(
                    chunk_size,
                    start_block,
                    next_block,
                    mode,
                    next_sequence,
                    SyncDirection::Backward,
                ),
            ),
            synced,
        }
    }

    async fn get_next_range(&mut self) -> ChainResult<Option<RangeInclusive<u32>>> {
        // Check if any new messages have been inserted into the DB,
        // and update the cursor accordingly.
        while !self.synced {
            if self
                .cursor
                .retrieve_message_by_nonce(self.cursor.sync_state.next_sequence)
                .await
                .is_none()
            {
                break;
            };
            // If we found sequence zero or hit block zero, we are done rewinding.
            if self.cursor.sync_state.next_sequence == 0 || self.cursor.sync_state.next_block == 0 {
                self.synced = true;
                break;
            }

            if let Some(block_number) = self
                .cursor
                .retrieve_dispatched_block_number(self.cursor.sync_state.next_sequence)
                .await
            {
                // It's possible that eth_getLogs dropped logs from this block, therefore we cannot do block_number - 1.
                self.cursor.sync_state.next_block = block_number;
            }

            self.cursor.sync_state.next_sequence =
                self.cursor.sync_state.next_sequence.saturating_sub(1);
        }
        if self.synced {
            return Ok(None);
        }

        // Just keep going backwards.
        let (count, tip) = self.cursor.indexer.sequence_and_tip().await?;
        self.cursor.sync_state.get_next_range(count, tip).await
    }

    /// If the previous block has been synced, rewind to the block number
    /// at which it was dispatched.
    /// Otherwise, rewind all the way back to the start block.
    async fn update(&mut self, logs: Vec<(HyperlaneMessage, LogMeta)>) -> Result<()> {
        let prev_sequence = self.cursor.sync_state.next_sequence.saturating_add(1);
        // We may wind up having re-indexed messages that are previous to the sequence (nonce) that we are looking for.
        // We should not consider these messages when checking for continuity errors.
        let filtered_logs = logs
            .into_iter()
            .filter(|m| m.0.nonce <= self.cursor.sync_state.next_sequence)
            .collect();
        self.cursor.update(filtered_logs, prev_sequence).await
    }
}

#[derive(Debug)]
pub enum SyncDirection {
    Forward,
    Backward,
}

/// A MessageSyncCursor that syncs forwards in perpetuity.
pub(crate) struct ForwardBackwardMessageSyncCursor {
    forward: ForwardMessageSyncCursor,
    backward: BackwardMessageSyncCursor,
    direction: SyncDirection,
}

impl ForwardBackwardMessageSyncCursor {
    /// Construct a new contract sync helper.
    pub async fn new(
        indexer: Arc<dyn SequenceIndexer<HyperlaneMessage>>,
        db: Arc<dyn HyperlaneMessageStore>,
        chunk_size: u32,
        mode: IndexMode,
    ) -> Result<Self> {
        let (count, tip) = indexer.sequence_and_tip().await?;
        let count = count.ok_or(ChainCommunicationError::from_other_str(
            "Failed to query message count",
        ))?;
        let forward_cursor = ForwardMessageSyncCursor::new(
            indexer.clone(),
            db.clone(),
            chunk_size,
            tip,
            tip,
            mode,
            count,
        );
        let backward_cursor = BackwardMessageSyncCursor::new(
            indexer.clone(),
            db.clone(),
            chunk_size,
            tip,
            tip,
            mode,
            count.saturating_sub(1),
            count == 0,
        );
        Ok(Self {
            forward: forward_cursor,
            backward: backward_cursor,
            direction: SyncDirection::Forward,
        })
    }
}

#[async_trait]
impl ContractSyncCursor<HyperlaneMessage> for ForwardBackwardMessageSyncCursor {
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

    fn latest_block(&self) -> u32 {
        self.forward.cursor.sync_state.next_block.saturating_sub(1)
    }

    async fn update(&mut self, logs: Vec<(HyperlaneMessage, LogMeta)>) -> Result<()> {
        match self.direction {
            SyncDirection::Forward => self.forward.update(logs).await,
            SyncDirection::Backward => self.backward.update(logs).await,
        }
    }
}

/// Tool for handling the logic of what the next block range that should be
/// queried is and also handling rate limiting. Rate limiting is automatically
/// performed by `next_action`.
pub(crate) struct RateLimitedContractSyncCursor<T> {
    indexer: Arc<dyn SequenceIndexer<T>>,
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
        indexer: Arc<dyn SequenceIndexer<T>>,
        db: Arc<dyn HyperlaneWatermarkedLogStore<T>>,
        chunk_size: u32,
        initial_height: u32,
        mode: IndexMode,
    ) -> Result<Self> {
        let (max_sequence, tip) = indexer.sequence_and_tip().await?;
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
    async fn get_rate_limit(&mut self) -> ChainResult<Option<Duration>> {
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
                    Err(e)
                }
            }
        }
    }

    fn sync_end(&self) -> ChainResult<u32> {
        match self.sync_state.mode {
            IndexMode::Block => Ok(self.tip),
            IndexMode::Sequence => {
                self.max_sequence
                    .ok_or(ChainCommunicationError::from_other_str(
                        "Sequence indexing requires a max sequence",
                    ))
            }
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
}

#[async_trait]
impl<T> ContractSyncCursor<T> for RateLimitedContractSyncCursor<T>
where
    T: Send + Debug + 'static,
{
    async fn next_action(&mut self) -> ChainResult<(CursorAction, Duration)> {
        let sync_end = self.sync_end()?;
        let to = u32::min(sync_end, self.sync_position() + self.sync_step());
        let from = self.sync_position();
        let eta = if to < sync_end {
            self.eta_calculator.calculate(from, sync_end)
        } else {
            Duration::from_secs(0)
        };

        let rate_limit = self.get_rate_limit().await?;
        if let Some(rate_limit) = rate_limit {
            return Ok((CursorAction::Sleep(rate_limit), eta));
        }
        let (max_sequence, tip) = self.indexer.sequence_and_tip().await?;
        self.tip = tip;
        self.max_sequence = max_sequence;
        if let Some(range) = self.sync_state.get_next_range(max_sequence, tip).await? {
            return Ok((CursorAction::Query(range), eta));
        }

        // TODO: Define the sleep time from interval flag
        Ok((CursorAction::Sleep(Duration::from_secs(5)), eta))
    }

    fn latest_block(&self) -> u32 {
        self.sync_state.next_block.saturating_sub(1)
    }

    async fn update(&mut self, _: Vec<(T, LogMeta)>) -> Result<()> {
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
        Ok(())
    }
}
