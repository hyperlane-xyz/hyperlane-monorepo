use std::collections::HashMap;
use std::ops::Deref;
use std::sync::Arc;
use std::time::Duration;

use eyre::Result;
use itertools::Itertools;
use prometheus::{IntCounter, IntGauge, IntGaugeVec};
use time::Instant;
use tracing::{debug, info, instrument, trace, warn};

use hyperlane_base::{last_message::validate_message_continuity, RateLimitedSyncBlockRangeCursor};
use hyperlane_core::{
    utils::fmt_duration, KnownHyperlaneDomain, ListValidity, MailboxIndexer, SyncBlockRangeCursor,
    H256,
};

use crate::chain_scraper::{
    Delivery, HyperlaneMessageWithMeta, Payment, SqlChainScraper, TxnWithId,
};

/// Workhorse of synchronization. This consumes a `SqlChainScraper` which has
/// the needed connections and information to work and then adds additional
/// running state that can be modified. This is a fn-like struct which allows us
/// to pass a bunch of state around without having a lot of arguments to
/// functions.
///
/// Conceptually this is *just* sync loop code with initial vars being
/// configured but as a struct + multiple functions.
pub(super) struct Syncer {
    scraper: SqlChainScraper,
    indexed_height: IntGauge,
    stored_messages: IntCounter,
    stored_deliveries: IntCounter,
    stored_payments: IntCounter,
    missed_messages: IntCounter,
    message_nonce: IntGaugeVec,
    sync_cursor: RateLimitedSyncBlockRangeCursor<Arc<dyn MailboxIndexer>>,

    last_valid_range_start_block: u32,
    last_nonce: Option<u32>,
}

impl Deref for Syncer {
    type Target = SqlChainScraper;

    fn deref(&self) -> &Self::Target {
        &self.scraper
    }
}

impl Syncer {
    /// Create a new syncer from the `SqlChainScraper` which holds the needed
    /// information and connections to create the running state.
    ///
    /// **Note:** Run must be called for syncing to commence.
    #[instrument(skip_all)]
    pub async fn new(scraper: SqlChainScraper) -> Result<Self> {
        let domain = scraper.domain();
        let chain_name = domain.name();

        let indexed_height = scraper
            .metrics
            .indexed_height
            .with_label_values(&["all", chain_name]);
        let stored_deliveries = scraper
            .metrics
            .stored_events
            .with_label_values(&["deliveries", chain_name]);
        let stored_payments = scraper
            .metrics
            .stored_events
            .with_label_values(&["gas_payments", chain_name]);
        let stored_messages = scraper
            .metrics
            .stored_events
            .with_label_values(&["messages", chain_name]);
        let missed_messages = scraper
            .metrics
            .missed_events
            .with_label_values(&["messages", chain_name]);
        let message_nonce = scraper.metrics.message_nonce.clone();

        let chunk_size = scraper.chunk_size;
        let initial_height = scraper.cursor.height().await as u32;
        let last_valid_range_start_block = initial_height;
        let last_nonce = scraper.last_message_nonce().await?;

        let sync_cursor = RateLimitedSyncBlockRangeCursor::new(
            scraper.contracts.mailbox_indexer.clone(),
            chunk_size,
            initial_height,
        )
        .await?;

        Ok(Self {
            scraper,
            indexed_height,
            stored_messages,
            stored_deliveries,
            stored_payments,
            missed_messages,
            message_nonce,
            sync_cursor,
            last_valid_range_start_block,
            last_nonce,
        })
    }

    /// Sync contract and other blockchain data with the current chain state.
    #[instrument(skip(self), fields(domain = %self.domain(), chunk_size = self.chunk_size))]
    pub async fn run(mut self) -> Result<()> {
        let start_block = self.sync_cursor.current_position();
        info!(from = start_block, "Resuming chain sync");
        self.indexed_height.set(start_block as i64);

        let mut last_logged_time: Option<Instant> = None;
        let mut should_log_checkpoint_info = || {
            if last_logged_time.is_none()
                || last_logged_time.unwrap().elapsed() > Duration::from_secs(30)
            {
                last_logged_time = Some(Instant::now());
                true
            } else {
                false
            }
        };

        loop {
            let start_block = self.sync_cursor.current_position();
            let Ok((from, to, eta)) = self.sync_cursor.next_range().await else { continue };
            if should_log_checkpoint_info() {
                info!(
                    from,
                    to,
                    distance_from_tip = self.sync_cursor.distance_from_tip(),
                    estimated_time_to_sync = fmt_duration(eta),
                    "Syncing range"
                );
            } else {
                debug!(
                    from,
                    to,
                    distance_from_tip = self.sync_cursor.distance_from_tip(),
                    estimated_time_to_sync = fmt_duration(eta),
                    "Syncing range"
                );
            }

            let extracted = self.scrape_range(from, to).await?;

            let validation = validate_message_continuity(
                self.last_nonce,
                &extracted
                    .sorted_messages
                    .iter()
                    .map(|r| &r.message)
                    .collect::<Vec<_>>(),
            );
            match validation {
                ListValidity::Valid => {
                    let max_nonce_of_batch = self.record_data(extracted).await?;

                    self.cursor.update(from as u64).await;
                    self.last_nonce = max_nonce_of_batch;
                    self.last_valid_range_start_block = from;
                    self.indexed_height.set(to as i64);
                }
                ListValidity::Empty => {
                    let _ = self.record_data(extracted).await?;
                    self.indexed_height.set(to as i64);
                }
                ListValidity::InvalidContinuation => {
                    self.missed_messages.inc();
                    warn!(
                        last_nonce = self.last_nonce,
                        start_block = from,
                        end_block = to,
                        last_valid_range_start_block = self.last_valid_range_start_block,
                        "Found invalid continuation in range. Re-indexing from the start block of the last successful range."
                    );
                    self.sync_cursor
                        .backtrack(self.last_valid_range_start_block);
                    self.indexed_height
                        .set(self.last_valid_range_start_block as i64);
                }
                ListValidity::ContainsGaps => {
                    self.missed_messages.inc();
                    self.sync_cursor.backtrack(start_block);
                    warn!(
                        last_nonce = self.last_nonce,
                        start_block = from,
                        end_block = to,
                        last_valid_range_start_block = self.last_valid_range_start_block,
                        "Found gaps in the message in range, re-indexing the same range."
                    );
                }
            }
        }
    }

    /// Fetch contract data from a given block range.
    #[instrument(skip(self))]
    async fn scrape_range(&self, from: u32, to: u32) -> Result<ExtractedData> {
        debug!(from, to, "Fetching messages for range");
        let sorted_messages = self
            .contracts
            .mailbox_indexer
            .fetch_sorted_messages(from, to)
            .await?;
        trace!(?sorted_messages, "Fetched messages");

        debug!("Fetching deliveries for range");
        let deliveries = self
            .contracts
            .mailbox_indexer
            .fetch_delivered_messages(from, to)
            .await?
            .into_iter()
            .map(|(message_id, meta)| Delivery { message_id, meta })
            .collect_vec();
        trace!(?deliveries, "Fetched deliveries");

        debug!("Fetching payments for range");
        let payments = self
            .contracts
            .igp_indexer
            .fetch_gas_payments(from, to)
            .await?
            .into_iter()
            .map(|(payment, meta)| Payment { payment, meta })
            .collect_vec();
        trace!(?payments, "Fetched payments");

        info!(
            message_count = sorted_messages.len(),
            delivery_count = deliveries.len(),
            payment_count = payments.len(),
            "Indexed block range for chain"
        );

        let sorted_messages = sorted_messages
            .into_iter()
            .map(|(message, meta)| HyperlaneMessageWithMeta { message, meta })
            .filter(|m| {
                self.last_nonce
                    .map_or(true, |last_nonce| m.message.nonce > last_nonce)
            })
            .collect::<Vec<_>>();

        debug!(
            message_count = sorted_messages.len(),
            "Filtered any messages already indexed for mailbox"
        );

        Ok(ExtractedData {
            sorted_messages,
            deliveries,
            payments,
        })
    }

    /// Record messages and deliveries, will fetch any extra data needed to do
    /// so. Returns the max nonce or None if no messages were provided.
    #[instrument(
        skip_all,
        fields(
            sorted_messages = extracted.sorted_messages.len(),
            deliveries = extracted.deliveries.len(),
            payments = extracted.payments.len()
        )
    )]
    async fn record_data(&self, extracted: ExtractedData) -> Result<Option<u32>> {
        let ExtractedData {
            sorted_messages,
            deliveries,
            payments,
        } = extracted;

        let txns: HashMap<H256, TxnWithId> = self
            .ensure_blocks_and_txns(
                sorted_messages
                    .iter()
                    .map(|r| &r.meta)
                    .chain(deliveries.iter().map(|d| &d.meta))
                    .chain(payments.iter().map(|p| &p.meta)),
            )
            .await?
            .map(|t| (t.hash, t))
            .collect();

        if !deliveries.is_empty() {
            self.store_deliveries(&deliveries, &txns).await?;
            self.stored_deliveries.inc_by(deliveries.len() as u64);
        }

        if !payments.is_empty() {
            self.store_payments(&payments, &txns).await?;
            self.stored_payments.inc_by(payments.len() as u64);
        }

        if !sorted_messages.is_empty() {
            let max_nonce_of_batch = self.store_messages(&sorted_messages, &txns).await?;
            self.stored_messages.inc_by(sorted_messages.len() as u64);

            for m in sorted_messages.iter() {
                let nonce = m.message.nonce;
                let dst = KnownHyperlaneDomain::try_from(m.message.destination)
                    .map(Into::into)
                    .unwrap_or("unknown");
                self.message_nonce
                    .with_label_values(&["dispatch", self.domain().name(), dst])
                    .set(nonce as i64);
            }
            Ok(Some(max_nonce_of_batch))
        } else {
            Ok(None)
        }
    }
}

struct ExtractedData {
    sorted_messages: Vec<HyperlaneMessageWithMeta>,
    deliveries: Vec<Delivery>,
    payments: Vec<Payment>,
}
