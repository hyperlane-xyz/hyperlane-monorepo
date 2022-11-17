use std::cmp::min;
use std::collections::HashMap;
use std::ops::Deref;
use std::time::Duration;

use ethers::prelude::H256;
use eyre::Result;
use itertools::Itertools;
use prometheus::{IntCounter, IntGauge, IntGaugeVec};
use tokio::time::sleep;
use tracing::{debug, info, instrument, warn};

use hyperlane_base::last_message::validate_message_continuity;
use hyperlane_core::{name_from_domain_id, ListValidity};

use crate::chain_scraper::{Delivery, HyperlaneMessageWithMeta, SqlChainScraper, TxnWithIdAndTime};

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
    indexed_message_height: IntGauge,
    indexed_deliveries_height: IntGauge,
    stored_messages: IntCounter,
    stored_deliveries: IntCounter,
    missed_messages: IntCounter,
    message_nonce: IntGaugeVec,
    chunk_size: u32,

    from: u32,
    last_valid_range_start_block: u32,
    last_nonce: u32,
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
        let chain_name = scraper.chain_name();
        let message_labels = ["messages", chain_name];
        let deliveries_labels = ["deliveries", chain_name];

        let indexed_message_height = scraper
            .metrics
            .indexed_height
            .with_label_values(&message_labels);
        let indexed_deliveries_height = scraper
            .metrics
            .indexed_height
            .with_label_values(&deliveries_labels);
        let stored_messages = scraper
            .metrics
            .stored_events
            .with_label_values(&message_labels);
        let stored_deliveries = scraper
            .metrics
            .stored_events
            .with_label_values(&deliveries_labels);
        let missed_messages = scraper
            .metrics
            .missed_events
            .with_label_values(&message_labels);
        let message_nonce = scraper.metrics.message_nonce.clone();

        let chunk_size = scraper.chunk_size;
        let from = scraper.cursor.height().await as u32;
        let last_valid_range_start_block = from;
        let last_nonce = scraper.last_message_nonce().await?.unwrap_or(0);

        Ok(Self {
            scraper,
            indexed_message_height,
            indexed_deliveries_height,
            stored_messages,
            stored_deliveries,
            missed_messages,
            message_nonce,
            chunk_size,
            from,
            last_valid_range_start_block,
            last_nonce,
        })
    }

    /// Sync contract and other blockchain data with the current chain state.
    #[instrument(skip(self), fields(chain_name = self.chain_name(), chink_size = self.chunk_size))]
    pub async fn run(mut self) -> Result<()> {
        info!(from = self.from, "Resuming chain sync");

        loop {
            self.indexed_message_height.set(self.from as i64);
            self.indexed_deliveries_height.set(self.from as i64);
            sleep(Duration::from_secs(5)).await;

            let Ok(tip) = self.get_finalized_block_number().await else {
                continue;
            };
            if tip <= self.from {
                sleep(Duration::from_secs(10)).await;
                continue;
            }

            let to = min(tip, self.from + self.chunk_size);
            let full_chunk_from = to.checked_sub(self.chunk_size).unwrap_or_default();
            debug_assert_eq!(self.local.mailbox.local_domain(), self.local_domain());
            let (sorted_messages, deliveries) = self.scrape_range(full_chunk_from, to).await?;

            let validation = validate_message_continuity(
                Some(self.last_nonce),
                &sorted_messages
                    .iter()
                    .map(|r| &r.message)
                    .collect::<Vec<_>>(),
            );
            match validation {
                ListValidity::Valid => {
                    let max_leaf_index_of_batch =
                        self.record_data(sorted_messages, deliveries).await?;

                    self.cursor.update(full_chunk_from as u64).await;
                    if let Some(idx) = max_leaf_index_of_batch {
                        self.last_nonce = idx;
                    }
                    self.last_valid_range_start_block = full_chunk_from;
                    self.from = to + 1;
                }
                ListValidity::Empty => {
                    let _ = self.record_data(sorted_messages, deliveries).await?;
                    self.from = to + 1;
                }
                ListValidity::InvalidContinuation => {
                    self.missed_messages.inc();
                    warn!(
                        last_nonce = self.last_nonce,
                        start_block = self.from,
                        end_block = to,
                        last_valid_range_start_block = self.last_valid_range_start_block,
                        "Found invalid continuation in range. Re-indexing from the start block of the last successful range."
                    );
                    self.from = self.last_valid_range_start_block;
                }
                ListValidity::ContainsGaps => {
                    self.missed_messages.inc();
                    warn!(
                        last_leaf_index = self.last_nonce,
                        start_block = self.from,
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
    async fn scrape_range(
        &self,
        from: u32,
        to: u32,
    ) -> Result<(Vec<HyperlaneMessageWithMeta>, Vec<Delivery>)> {
        let sorted_messages = self.local.indexer.fetch_sorted_messages(from, to).await?;

        let deliveries = self
            .local
            .indexer
            .fetch_delivered_messages(from, to)
            .await?
            .into_iter()
            .map(|(message_id, meta)| Delivery {
                destination_mailbox: self.local.mailbox.address(),
                message_id,
                meta,
            })
            .collect_vec();

        info!(
            from,
            to,
            message_count = sorted_messages.len(),
            deliveries_count = deliveries.len(),
            "Indexed block range for chain"
        );

        let sorted_messages = sorted_messages
            .into_iter()
            .map(|(message, meta)| HyperlaneMessageWithMeta { message, meta })
            .filter(|m| m.message.nonce > self.last_nonce)
            .collect::<Vec<_>>();

        debug!(
            from,
            to,
            message_count = sorted_messages.len(),
            "Filtered any messages already indexed for outbox."
        );

        Ok((sorted_messages, deliveries))
    }

    /// Record messages and deliveries, will fetch any extra data needed to do
    /// so. Returns the max leaf index or None if no messages were provided.
    #[instrument(
        skip_all,
        fields(sorted_messages = sorted_messages.len(), deliveries = deliveries.len())
    )]
    async fn record_data(
        &self,
        sorted_messages: Vec<HyperlaneMessageWithMeta>,
        deliveries: Vec<Delivery>,
    ) -> Result<Option<u32>> {
        let txns: HashMap<H256, TxnWithIdAndTime> = self
            .ensure_blocks_and_txns(
                sorted_messages
                    .iter()
                    .map(|r| &r.meta)
                    .chain(deliveries.iter().map(|d| &d.meta)),
            )
            .await?
            .map(|t| (t.hash, t))
            .collect();

        if !deliveries.is_empty() {
            self.store_deliveries(&deliveries, &txns).await?;
            self.stored_deliveries.inc_by(deliveries.len() as u64);
        }

        if !sorted_messages.is_empty() {
            let max_nonce_of_batch = self.store_messages(&sorted_messages, &txns).await?;
            self.stored_messages.inc_by(sorted_messages.len() as u64);

            for m in sorted_messages.iter() {
                let nonce = m.message.nonce;
                let dst =
                    name_from_domain_id(m.message.destination).unwrap_or_else(|| "unknown".into());
                self.message_nonce
                    .with_label_values(&["dispatch", self.chain_name(), &dst])
                    .set(nonce as i64);
            }
            Ok(Some(max_nonce_of_batch))
        } else {
            Ok(None)
        }
    }
}
