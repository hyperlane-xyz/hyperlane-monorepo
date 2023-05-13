use std::{time::{Duration, Instant}};

use async_trait::async_trait;
use eyre::Result;
use tokio::time::sleep;
use tracing::{warn, error};

use hyperlane_core::{ChainResult, Indexer, SyncBlockRangeCursor, MailboxIndexer};

use crate::{contract_sync::eta_calculator::SyncerEtaCalculator, db::HyperlaneDB};

/// Time window for the moving average used in the eta calculator in seconds.
const ETA_TIME_WINDOW: f64 = 2. * 60.;

pub struct MessageSyncBlockRangeCursor<I> {
    /// The MailboxIndexer that this cursor is associated with.
    indexer: I,
    /// The HyperlaneDB that this cursor is associated with.
    db: HyperlaneDB,
    /// The size of the largest block range that should be returned by the cursor.
    chunk_size: u32,
    /// All blocks before this are considered "synced"
    from_block: u32,
    /// The latest message nonce that the cursor can consider "synced".
    /// None if the cursor should assume no messages have been synced.
    message_nonce: Option<u32>,
}

impl<I> MessageSyncBlockRangeCursor <I>
where
    I: MailboxIndexer,
{
    /// Construct a new contract sync helper.
    pub async fn new(indexer: I, db: HyperlaneDB, chunk_size: u32, from_block: u32, message_nonce: Option<u32>) -> Result<Self> {
        Ok(Self {
            indexer,
            db,
            chunk_size,
            from_block,
            message_nonce
        })
    }

    /// Returns the next message nonce that should be indexed
    pub fn next_nonce(&self) -> u32 {
        self.message_nonce.map(|nonce| nonce + 1).unwrap_or(0)
    }

    fn dispatched_block_number_by_nonce(&self, nonce: u32) -> Option<u32> {
        if let Ok(Some(block_number)) = self.db.dispatched_block_number_by_nonce(nonce) {
            Some(u32::try_from(block_number).unwrap())
        } else {
            None
        }
    }
}

#[async_trait]
impl<I: MailboxIndexer> SyncBlockRangeCursor for MessageSyncBlockRangeCursor<I> {
    fn current_position(&self) -> u32 {
        self.from_block
    }

    // TODO: We don't need this, right?
    fn tip(&self) -> u32 {
        0
    }

    async fn next_range(&mut self) -> ChainResult<Option<(u32, u32, Duration)>> {
        // First, check if any new messages have been inserted into the DB,
        // and update the latest synced nonce accordingly.
        loop {
            let next_nonce = self.next_nonce();
                if let Some(block_number) = self.dispatched_block_number_by_nonce(next_nonce) {
                    self.message_nonce = Some(next_nonce);
                    self.from_block = block_number; 
                } else {
                    break;
                }
        }

        // Maybe just have the mailbox return the count and tip at the same time?
        let (mailbox_count, tip) = self.indexer.fetch_count_at_tip().await?;
        let cursor_count = self.next_nonce();

        if cursor_count == mailbox_count {
            // We are synced up to the latest nonce so we don't need to index anything.
            // We update our latest block number accordingly.
            self.from_block = tip;
            Ok(None)
        } else if cursor_count < mailbox_count {
            // The cursor is behind the mailbox, so we need to index some blocks.
            // We attempt to index a range of blocks that is as large as possible.
            let from = self.from_block;
            let to = u32::min(tip, from + self.chunk_size);
            self.from_block = to + 1;
            Ok(Some((from, to, Duration::from_secs(0))))
        } else {
            error!("Cursor is ahead of mailbox, this should never happen.");
            // TODO: This is not okay...
            Ok(None)
        }
    }

    fn backtrack(&mut self, from_block: u32) -> ChainResult<u32> {
        // If we have a known indexed message, backtrack to the block that message
        // was dispatched in.
        // If not, backtrack all the way to the provided from_block.
        if let Some(nonce) = self.message_nonce {
            if let Some(block_number) = self.dispatched_block_number_by_nonce(nonce) {
                self.from_block = block_number; 
            } else {
                self.from_block = from_block;
            }
        } else {
            self.from_block = from_block;
        } 
        Ok(self.from_block)
    }
}

/// Tool for handling the logic of what the next block range that should be
/// queried is and also handling rate limiting. Rate limiting is automatically
/// performed by `next_range`.
pub struct RateLimitedSyncBlockRangeCursor<I> {
    indexer: I,
    tip: u32,
    last_tip_update: Instant,
    chunk_size: u32,
    from: u32,
    eta_calculator: SyncerEtaCalculator,
}

impl<I> RateLimitedSyncBlockRangeCursor<I>
where
    I: Indexer,
{
    /// Construct a new contract sync helper.
    pub async fn new(indexer: I, chunk_size: u32, initial_height: u32) -> Result<Self> {
        let tip = indexer.get_finalized_block_number().await?;
        Ok(Self {
            indexer,
            tip,
            chunk_size,
            last_tip_update: Instant::now(),
            from: initial_height,
            eta_calculator: SyncerEtaCalculator::new(initial_height, tip, ETA_TIME_WINDOW),
        })
    }

    /// Wait based on how close we are to the tip and update the tip,
    /// i.e. the highest block we may scrape.
    async fn rate_limit(&mut self) -> ChainResult<()> {
        let update_tip = self.last_tip_update.elapsed() >= Duration::from_secs(30);
        if self.from + self.chunk_size < self.tip {
            // If doing the full chunk wouldn't exceed the already known tip sleep a tiny
            // bit so that we can catch up relatively quickly.
            sleep(Duration::from_millis(100)).await;
        } else if !update_tip {
            // We are close to the tip.
            // Sleep a little longer because we have caught up.
            sleep(Duration::from_secs(10)).await;
        }

        if !update_tip {
            return Ok(());
        }
        match self.indexer.get_finalized_block_number().await {
            Ok(tip) => {
                // we retrieved a new tip value, go ahead and update.
                self.last_tip_update = Instant::now();
                self.tip = tip;
                Ok(())
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

#[async_trait]
impl<I: Indexer> SyncBlockRangeCursor for RateLimitedSyncBlockRangeCursor<I> {
    fn current_position(&self) -> u32 {
        self.from
    }

    fn tip(&self) -> u32 {
        self.tip
    }

    async fn next_range(&mut self) -> ChainResult<Option<(u32, u32, Duration)>> {
        self.rate_limit().await?;
        let to = u32::min(self.tip, self.from + self.chunk_size);
        let from = to.saturating_sub(self.chunk_size);
        self.from = to + 1;
        let eta = if to < self.tip {
            self.eta_calculator.calculate(from, self.tip)
        } else {
            Duration::from_secs(0)
        };
        Ok(Some((from, to, eta)))
    }

    fn backtrack(&mut self, start_from: u32) -> ChainResult<u32> {
        self.from = u32::min(start_from, self.from);
        Ok(self.from)
    }
}
