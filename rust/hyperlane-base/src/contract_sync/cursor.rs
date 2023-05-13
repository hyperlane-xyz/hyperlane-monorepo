use std::{time::{Duration, Instant}};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use tokio::time::sleep;
use tracing::{warn, error, info};

use hyperlane_core::{ChainResult, Indexer, SyncBlockRangeCursor, MessageSyncCursor, MailboxIndexer};

use crate::{contract_sync::eta_calculator::SyncerEtaCalculator, db::HyperlaneDB};

/// Time window for the moving average used in the eta calculator in seconds.
const ETA_TIME_WINDOW: f64 = 2. * 60.;

// Forward pass starting at zero:
//   synced nonce = none
//   next nonce = mailbox.count()
// Backward pass starting at zero:
//   synced nonce = mailbox.count()
//   next nonce = None
// Forward pass starting at non-zero:
//   synced nonce = mailbox.count() - 1
//   next nonce = mailbox.count()
// Backward pass starting at non-zero:
//   synced nonce = mailbox.count()
//   next nonce = mailbox.count() - 1

#[derive(new, Debug, Clone)]
pub struct MessageSyncCursorData<I> {
    /// The MailboxIndexer that this cursor is associated with.
    indexer: I,
    /// The HyperlaneDB that this cursor is associated with.
    db: HyperlaneDB,
    /// The size of the largest block range that should be returned by the cursor.
    chunk_size: u32,
    /// The starting block for the cursor
    start_block: u32,
    /// The next block that should be indexed.
    next_block: u32,
    /// The next nonce that the cursor is looking for.
    next_nonce: u32,
}

impl<I> MessageSyncCursorData<I>
where
    I: MailboxIndexer,
{
    fn dispatched_block_number_by_nonce(&self, nonce: u32) -> Option<u32> {
        if let Ok(Some(block_number)) = self.db.dispatched_block_number_by_nonce(nonce) {
            Some(u32::try_from(block_number).unwrap())
        } else {
            None
        }
    }

    /// If the previous block has been synced, rewind to the block number
    /// at which it was dispatched.
    /// Otherwise, rewind all the way back to the start block.
    fn rewind_to_nonce(&mut self, nonce: u32) -> ChainResult<u32> {
        if let Some(block_number) = self.dispatched_block_number_by_nonce(nonce) {
            self.next_block = block_number; 
        } else {
            self.next_block = self.start_block;
        }
        Ok(self.next_block)
    }
}




#[derive(new, Debug, Clone)]
pub struct ForwardMessageSyncCursor<I> {
    cursor: MessageSyncCursorData<I>,
}

#[async_trait]
impl<I> MessageSyncCursor for ForwardMessageSyncCursor<I>
where
    I: MailboxIndexer + 'static,
{

    /// Check if any new messages have been inserted into the DB,
    /// and update the cursor accordingly.
    fn fast_forward(&mut self) -> bool {
        loop {
            if let Some(block_number) = self.cursor.dispatched_block_number_by_nonce(self.cursor.next_nonce) {
                self.cursor.next_nonce += 1;
                self.cursor.next_block = block_number; 
            } else {
                break;
            }
        }
        true
    }

    fn next_nonce(&self) -> u32 {
        self.cursor.next_nonce
    }

    async fn next_range(&mut self) -> ChainResult<Option<(u32, u32, Duration)>> {
        info!(nonce = self.cursor.next_nonce, block = self.cursor.next_block, "forward range");
        self.fast_forward();

        let (mailbox_count, tip) = self.cursor.indexer.fetch_count_at_tip().await?;
        let cursor_count = self.next_nonce();

        if cursor_count == mailbox_count {
            // We are synced up to the latest nonce so we don't need to index anything.
            // We update our next block number accordingly.
            self.cursor.next_block = tip;
            Ok(None)
        } else if cursor_count < mailbox_count {
            // The cursor is behind the mailbox, so we need to index some blocks.
            // We attempt to index a range of blocks that is as large as possible.
            let from = self.cursor.next_block;
            let to = u32::min(tip, from + self.cursor.chunk_size);
            self.cursor.next_block = to + 1;
            Ok(Some((from, to, Duration::from_secs(0))))
        } else {
            error!("Cursor is ahead of mailbox, this should never happen.");
            // TODO: This is not okay...
            Ok(None)
        }
    }

    /// If the previous block has been synced, rewind to the block number
    /// at which it was dispatched.
    /// Otherwise, rewind all the way back to the start block.
    fn rewind(&mut self) -> ChainResult<u32> {
        let prev_nonce = self.next_nonce().saturating_sub(1);
        self.cursor.rewind_to_nonce(prev_nonce)
    }

}

#[derive(new, Debug, Clone)]
pub struct BackwardMessageSyncCursor<I> {
    cursor: MessageSyncCursorData<I>,
}

#[async_trait]
impl<I> MessageSyncCursor for BackwardMessageSyncCursor<I>
where
    I: MailboxIndexer + 'static,
{
    /// Check if any new messages have been inserted into the DB,
    /// and update the cursor accordingly.
    fn fast_forward(&mut self) -> bool {
        loop {
            if let Some(block_number) = self.cursor.dispatched_block_number_by_nonce(self.cursor.next_nonce) {
                self.cursor.next_block = block_number; 
                // If we hit nonce zero, we are done fast forwarding.
                if self.cursor.next_nonce == 0 {
                   return false;
                }
                self.cursor.next_nonce = self.cursor.next_nonce.saturating_sub(1);
            } else {
                return true;
            }
        }
    }

    fn next_nonce(&self) -> u32 {
        self.cursor.next_nonce
    }

    async fn next_range(&mut self) -> ChainResult<Option<(u32, u32, Duration)>> {
        info!(nonce = self.cursor.next_nonce, block = self.cursor.next_block, "backward range");
        self.fast_forward();
        // Just keep going backwards.
        let to = self.cursor.next_block;
        let from = to.saturating_sub(self.cursor.chunk_size);
        self.cursor.next_block = from.saturating_sub(1);
        Ok(Some((from, to, Duration::from_secs(0))))
    }

    /// If the previous block has been synced, rewind to the block number
    /// at which it was dispatched.
    /// Otherwise, rewind all the way back to the start block.
    fn rewind(&mut self) -> ChainResult<u32> {
        let prev_nonce = self.next_nonce().saturating_add(1);
        self.cursor.rewind_to_nonce(prev_nonce)
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
