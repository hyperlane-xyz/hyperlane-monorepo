use std::collections::HashMap;
use std::ops::Deref;
use std::sync::Arc;

use abacus_base::ContractSyncHelper;
use ethers::prelude::H256;
use eyre::Result;
use prometheus::{IntCounter, IntGauge, IntGaugeVec};
use tracing::{debug, info, instrument, warn};

use abacus_base::last_message::validate_message_continuity;
use abacus_core::{name_from_domain_id, CommittedMessage, ListValidity, OutboxIndexer};

use crate::chain_scraper::{Delivery, RawMsgWithMeta, SqlChainScraper, TxnWithIdAndTime};

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
    message_leaf_index: IntGaugeVec,
    sync_helper: ContractSyncHelper<Arc<dyn OutboxIndexer>>,

    last_valid_range_start_block: u32,
    last_leaf_index: u32,
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
        let message_leaf_index = scraper.metrics.message_leaf_index.clone();

        let chunk_size = scraper.chunk_size;
        let initial_height = scraper.cursor.height().await as u32;
        let last_valid_range_start_block = initial_height;
        let last_leaf_index = scraper.last_message_leaf_index().await?.unwrap_or(0);

        let sync_helper =
            ContractSyncHelper::new(scraper.local.indexer.clone(), chunk_size, initial_height)
                .await?;

        Ok(Self {
            scraper,
            indexed_message_height,
            indexed_deliveries_height,
            stored_messages,
            stored_deliveries,
            missed_messages,
            message_leaf_index,
            sync_helper,
            last_valid_range_start_block,
            last_leaf_index,
        })
    }

    /// Sync contract and other blockchain data with the current chain state.
    #[instrument(skip(self), fields(chain_name = self.chain_name(), chink_size = self.chunk_size))]
    pub async fn run(mut self) -> Result<()> {
        let start_block = self.sync_helper.current_position();
        info!(from = start_block, "Resuming chain sync");
        self.indexed_message_height.set(start_block as i64);
        self.indexed_deliveries_height.set(start_block as i64);

        loop {
            debug_assert_eq!(self.local.outbox.local_domain(), self.local_domain());
            let start_block = self.sync_helper.current_position();
            let Ok((from, to)) = self.sync_helper.next_range().await else { continue };

            let (sorted_messages, deliveries) = self.scrape_range(from, to).await?;

            let validation = validate_message_continuity(
                Some(self.last_leaf_index),
                &sorted_messages.iter().map(|r| &r.raw).collect::<Vec<_>>(),
            );
            match validation {
                ListValidity::Valid => {
                    let max_leaf_index_of_batch =
                        self.record_data(sorted_messages, deliveries).await?;

                    self.cursor.update(from as u64).await;
                    if let Some(idx) = max_leaf_index_of_batch {
                        self.last_leaf_index = idx;
                    }
                    self.last_valid_range_start_block = from;
                    self.indexed_message_height.set(to as i64);
                    self.indexed_deliveries_height.set(to as i64);
                }
                ListValidity::Empty => {
                    let _ = self.record_data(sorted_messages, deliveries).await?;
                    self.indexed_message_height.set(to as i64);
                    self.indexed_deliveries_height.set(to as i64);
                }
                ListValidity::InvalidContinuation => {
                    self.missed_messages.inc();
                    warn!(
                        last_leaf_index = self.last_leaf_index,
                        start_block = from,
                        end_block = to,
                        last_valid_range_start_block = self.last_valid_range_start_block,
                        "Found invalid continuation in range. Re-indexing from the start block of the last successful range."
                    );
                    self.sync_helper
                        .backtrack(self.last_valid_range_start_block);
                    self.indexed_message_height
                        .set(self.last_valid_range_start_block as i64);
                    self.indexed_deliveries_height
                        .set(self.last_valid_range_start_block as i64);
                }
                ListValidity::ContainsGaps => {
                    self.missed_messages.inc();
                    self.sync_helper.backtrack(start_block);
                    warn!(
                        last_leaf_index = self.last_leaf_index,
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
    async fn scrape_range(
        &self,
        from: u32,
        to: u32,
    ) -> Result<(Vec<RawMsgWithMeta>, Vec<Delivery>)> {
        let sorted_messages = self.local.indexer.fetch_sorted_messages(from, to).await?;

        let deliveries = self.deliveries(from, to).await?;

        info!(
            from,
            to,
            message_count = sorted_messages.len(),
            deliveries_count = deliveries.len(),
            "Indexed block range for chain"
        );

        let sorted_messages = sorted_messages
            .into_iter()
            .map(|(raw, meta)| RawMsgWithMeta { raw, meta })
            .filter(|m| m.raw.leaf_index > self.last_leaf_index)
            .collect::<Vec<_>>();

        debug!(
            from,
            to,
            message_count = sorted_messages.len(),
            "Filtered any messages already indexed for outbox."
        );

        Ok((sorted_messages, deliveries))
    }

    /// get the deliveries for a given range from the inboxes.
    #[instrument(skip(self))]
    async fn deliveries(&self, from: u32, to: u32) -> Result<Vec<Delivery>> {
        let mut delivered = vec![];
        for (_, remote) in self.remotes.iter() {
            debug_assert_eq!(remote.inbox.local_domain(), self.local_domain());
            delivered.extend(
                remote
                    .indexer
                    .fetch_processed_messages(from, to)
                    .await?
                    .into_iter()
                    .map(|(message_hash, meta)| Delivery {
                        inbox: remote.inbox.address(),
                        message_hash,
                        meta,
                    }),
            )
        }
        Ok(delivered)
    }

    /// Record messages and deliveries, will fetch any extra data needed to do
    /// so. Returns the max leaf index or None if no messages were provided.
    #[instrument(
        skip_all,
        fields(sorted_messages = sorted_messages.len(), deliveries = deliveries.len())
    )]
    async fn record_data(
        &self,
        sorted_messages: Vec<RawMsgWithMeta>,
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
            let max_leaf_index_of_batch = self.store_messages(&sorted_messages, &txns).await?;
            self.stored_messages.inc_by(sorted_messages.len() as u64);

            for m in sorted_messages.iter() {
                let parsed = CommittedMessage::try_from(&m.raw).ok();
                let idx = m.raw.leaf_index;
                let dst = parsed
                    .and_then(|msg| name_from_domain_id(msg.message.destination))
                    .unwrap_or_else(|| "unknown".into());
                self.message_leaf_index
                    .with_label_values(&["dispatch", self.chain_name(), &dst])
                    .set(idx as i64);
            }
            Ok(Some(max_leaf_index_of_batch))
        } else {
            Ok(None)
        }
    }
}
