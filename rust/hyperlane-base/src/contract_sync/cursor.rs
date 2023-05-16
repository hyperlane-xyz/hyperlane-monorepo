use std::fmt::Debug;
use std::{
    cmp::Ordering,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use tokio::time::sleep;
use tracing::warn;

use hyperlane_core::{
    ChainResult, ContractSyncCursor, HyperlaneMessage, HyperlaneMessageDB, Indexer, LogMeta,
    MessageIndexer,
};

use crate::contract_sync::eta_calculator::SyncerEtaCalculator;

/// Time window for the moving average used in the eta calculator in seconds.
const ETA_TIME_WINDOW: f64 = 2. * 60.;

/// A struct that holds the data needed for forwards and backwards
/// message sync cursors.
#[derive(Debug, new)]
pub(crate) struct MessageSyncCursor {
    indexer: Arc<dyn MessageIndexer>,
    db: Arc<dyn HyperlaneMessageDB>,
    chunk_size: u32,
    /// The starting block for the cursor
    start_block: u32,
    /// The next block that should be indexed.
    next_block: u32,
    /// The next nonce that the cursor is looking for.
    next_nonce: u32,
}

impl MessageSyncCursor {
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
        prev_nonce: u32,
    ) -> eyre::Result<()> {
        // If we found messages, but did *not* find the message we were looking for,
        // we need to rewind to the block at which we found the last message.
        if !logs.is_empty() && !logs.iter().any(|m| m.0.nonce == self.next_nonce) {
            self.rewind_to_nonce(prev_nonce).await?;
            Ok(())
        } else {
            Ok(())
        }
    }

    /// If the previous block has been synced, rewind to the block number
    /// at which it was dispatched.
    /// Otherwise, rewind all the way back to the start block.
    async fn rewind_to_nonce(&mut self, nonce: u32) -> ChainResult<u32> {
        if let Some(block_number) = self.retrieve_dispatched_block_number(nonce).await {
            self.next_block = block_number;
        } else {
            self.next_block = self.start_block;
        }
        Ok(self.next_block)
    }
}

/// A MessageSyncCursor that syncs forwards in perpetuity.
#[derive(new)]
pub(crate) struct ForwardMessageSyncCursor(MessageSyncCursor);

impl ForwardMessageSyncCursor {
    /// Check if any new messages have been inserted into the DB,
    /// and update the cursor accordingly.
    async fn fast_forward(&mut self) {
        while let Some(block_number) = self
            .0
            .retrieve_dispatched_block_number(self.0.next_nonce)
            .await
        {
            self.0.next_nonce += 1;
            self.0.next_block = block_number;
        }
    }

    async fn get_next_range(&mut self) -> ChainResult<Option<(u32, u32, Duration)>> {
        self.fast_forward().await;
        let (mailbox_count, tip) = self.0.indexer.fetch_count_at_tip().await?;
        let cursor_count = self.0.next_nonce;

        let cmp = cursor_count.cmp(&mailbox_count);
        match cmp {
            Ordering::Equal => {
                // We are synced up to the latest nonce so we don't need to index anything.
                // We update our next block number accordingly.
                self.0.next_block = tip;
                return Ok(None);
            }
            Ordering::Less => {
                // The cursor is behind the mailbox, so we need to index some blocks.
                // We attempt to index a range of blocks that is as large as possible.
                let from = self.0.next_block;
                let to = u32::min(tip, from + self.0.chunk_size);
                self.0.next_block = to + 1;
                return Ok(Some((from, to, Duration::from_secs(0))));
            }
            Ordering::Greater => {
                panic!("Cursor is ahead of mailbox, this should never happen.");
            }
        }
    }
}

#[async_trait]
impl ContractSyncCursor<HyperlaneMessage> for ForwardMessageSyncCursor {
    async fn next_range(&mut self) -> ChainResult<(u32, u32, Duration)> {
        loop {
            let range = self.get_next_range().await?;
            match range {
                Some(range) => {
                    return Ok(range);
                }
                None => {
                    // TODO: Define the sleep time from interval flag
                    sleep(Duration::from_secs(5)).await;
                }
            }
        }
    }

    /// If the previous block has been synced, rewind to the block number
    /// at which it was dispatched.
    /// Otherwise, rewind all the way back to the start block.
    async fn update(&mut self, logs: Vec<(HyperlaneMessage, LogMeta)>) -> eyre::Result<()> {
        let prev_nonce = self.0.next_nonce.saturating_sub(1);
        self.0.update(logs, prev_nonce).await
    }
}

/// A MessageSyncCursor that syncs backwards to nonce zero.
#[derive(new)]
pub(crate) struct BackwardMessageSyncCursor {
    cursor: MessageSyncCursor,
    synced: bool,
}

impl BackwardMessageSyncCursor {
    /// Check if any new messages have been inserted into the DB,
    /// and update the cursor accordingly.
    async fn rewind(&mut self) {
        while !self.synced {
            if let Some(block_number) = self
                .cursor
                .retrieve_dispatched_block_number(self.cursor.next_nonce)
                .await
            {
                self.cursor.next_block = block_number;
                // If we found nonce zero, we are done rewinding.
                if self.cursor.next_nonce == 0 {
                    self.synced = true;
                    break;
                }
                self.cursor.next_nonce = self.cursor.next_nonce.saturating_sub(1);
            } else {
                break;
            }
        }
    }

    async fn get_next_range(&mut self) -> Option<(u32, u32, Duration)> {
        self.rewind().await;
        if self.synced {
            return None;
        } else {
            // Just keep going backwards.
            let to = self.cursor.next_block;
            let from = to.saturating_sub(self.cursor.chunk_size);
            self.cursor.next_block = from.saturating_sub(1);
            Some((from, to, Duration::from_secs(0)))
        }
    }

    /// If the previous block has been synced, rewind to the block number
    /// at which it was dispatched.
    /// Otherwise, rewind all the way back to the start block.
    async fn update(&mut self, logs: Vec<(HyperlaneMessage, LogMeta)>) -> eyre::Result<()> {
        let prev_nonce = self.cursor.next_nonce.saturating_add(1);
        self.cursor.update(logs, prev_nonce).await
    }
}

enum SyncDirection {
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
        indexer: Arc<dyn MessageIndexer>,
        db: Arc<dyn HyperlaneMessageDB>,
        chunk_size: u32,
    ) -> Result<Self> {
        let (count, tip) = indexer.fetch_count_at_tip().await?;
        let forward_cursor = ForwardMessageSyncCursor::new(MessageSyncCursor::new(
            indexer.clone(),
            db.clone(),
            chunk_size,
            tip,
            tip,
            count,
        ));

        let backward_cursor = BackwardMessageSyncCursor::new(
            MessageSyncCursor::new(
                indexer.clone(),
                db.clone(),
                chunk_size,
                tip,
                tip,
                count.saturating_sub(1),
            ),
            false,
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
    async fn next_range(&mut self) -> ChainResult<(u32, u32, Duration)> {
        loop {
            let forward_range = self.forward.get_next_range().await?;
            match forward_range {
                Some(range) => {
                    self.direction = SyncDirection::Forward;
                    return Ok(range);
                }
                None => {
                    let backward_range = self.backward.get_next_range().await;
                    match backward_range {
                        Some(range) => {
                            self.direction = SyncDirection::Backward;
                            return Ok(range);
                        }
                        None => {
                            // TODO: Define the sleep time from interval flag
                            sleep(Duration::from_secs(5)).await;
                        }
                    }
                }
            }
        }
    }

    async fn update(&mut self, logs: Vec<(HyperlaneMessage, LogMeta)>) -> eyre::Result<()> {
        match self.direction {
            SyncDirection::Forward => self.forward.update(logs).await,
            SyncDirection::Backward => self.backward.update(logs).await,
        }
    }
}

/// Tool for handling the logic of what the next block range that should be
/// queried is and also handling rate limiting. Rate limiting is automatically
/// performed by `next_range`.
pub(crate) struct RateLimitedContractSyncCursor<T> {
    // TODO: It's weird that ContractSync takes an indexer *and* cursors take an indexer...
    indexer: Arc<dyn Indexer<T>>,
    tip: u32,
    last_tip_update: Instant,
    chunk_size: u32,
    from: u32,
    eta_calculator: SyncerEtaCalculator,
}

impl<T> RateLimitedContractSyncCursor<T> {
    /// Construct a new contract sync helper.
    pub async fn new(
        indexer: Arc<dyn Indexer<T>>,
        chunk_size: u32,
        initial_height: u32,
    ) -> Result<Self> {
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
impl<T> ContractSyncCursor<T> for RateLimitedContractSyncCursor<T>
where
    T: Send + Debug + 'static,
{
    async fn next_range(&mut self) -> ChainResult<(u32, u32, Duration)> {
        self.rate_limit().await?;
        let to = u32::min(self.tip, self.from + self.chunk_size);
        let from = to.saturating_sub(self.chunk_size);
        self.from = to + 1;
        let eta = if to < self.tip {
            self.eta_calculator.calculate(from, self.tip)
        } else {
            Duration::from_secs(0)
        };
        Ok((from, to, eta))
    }

    async fn update(&mut self, _: Vec<(T, LogMeta)>) -> eyre::Result<()> {
        Ok(())
    }
}
