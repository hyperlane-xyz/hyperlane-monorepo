use std::cmp::min;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use eyre::Result;
use sea_orm::{Database, DbConn};
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::{debug, info, info_span, Instrument, warn};
use tracing::instrument::Instrumented;

use abacus_base::{
    BaseAgent, ChainSetup, ContractSyncMetrics, CoreMetrics, IndexSettings, OutboxAddresses,
    run_all, Settings,
};
use abacus_base::last_message::validate_message_continuity;
use abacus_core::{
    AbacusCommon, AbacusContract, CommittedMessage, ListValidity, name_from_domain_id, Outbox,
    OutboxIndexer, RawCommittedMessage,
};

use crate::scraper::block_cursor::BlockCursor;
use crate::settings::ScraperSettings;

mod block_cursor;

/// A message explorer scraper agent
#[derive(Debug)]
pub struct Scraper {
    metrics: Arc<CoreMetrics>,
    /// A map of outbox contracts by name.
    outboxes: HashMap<String, SqlOutboxScraper>,
    inboxes: HashMap<String, ()>,
    gas_paymasters: HashMap<String, ()>,
}

#[async_trait]
impl BaseAgent for Scraper {
    const AGENT_NAME: &'static str = "scraper";
    type Settings = ScraperSettings;

    fn metrics(&self) -> &Arc<CoreMetrics> {
        &self.metrics
    }

    async fn from_settings(settings: Self::Settings) -> Result<Self>
    where
        Self: Sized,
    {
        let core_settings: Settings = settings.base;
        let metrics = core_settings.try_into_metrics(Self::AGENT_NAME)?;

        let db = Database::connect(&core_settings.db).await?;
        let outboxes =
            Self::load_outboxes(&db, &core_settings, settings.outboxes, &metrics).await?;
        let inboxes = Self::load_inboxes(&db, &core_settings, &metrics).await?;
        let gas_paymasters = Self::load_gas_paymasters(&db, &core_settings, &metrics).await?;
        Ok(Self {
            metrics,
            outboxes,
            inboxes,
            gas_paymasters,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let tasks = self
            .outboxes
            .iter()
            .map(|(name, outbox)| {
                let span = info_span!("OutboxContractSync", %name, self = ?outbox);
                let syncer = outbox.clone().sync();
                tokio::spawn(syncer).instrument(span)
            })
            .collect();

        run_all(tasks)
    }
}

impl Scraper {
    async fn load_outboxes(
        db: &DbConn,
        core_settings: &Settings,
        config: HashMap<String, ChainSetup<OutboxAddresses>>,
        metrics: &Arc<CoreMetrics>,
    ) -> Result<HashMap<String, SqlOutboxScraper>> {
        let contract_sync_metrics = ContractSyncMetrics::new(metrics.clone());
        let mut outboxes = HashMap::new();
        for (name, outbox_setup) in config {
            let signer = core_settings.get_signer(&name).await;
            let outbox = core_settings
                .outbox
                .try_into_outbox(signer, metrics)
                .await?;
            let indexer = core_settings
                .try_outbox_indexer_from_config(metrics, &outbox_setup)
                .await?;
            outboxes.insert(
                name,
                SqlOutboxScraper::new(
                    db.clone(),
                    outbox.into(),
                    indexer.into(),
                    core_settings.index.clone(),
                    contract_sync_metrics.clone(),
                )
                .await?,
            );
        }
        Ok(outboxes)
    }

    async fn load_inboxes(
        _db: &DbConn,
        _core_settings: &Settings,
        _metrics: &Arc<CoreMetrics>,
    ) -> Result<HashMap<String, ()>> {
        todo!()
    }

    async fn load_gas_paymasters(
        _db: &DbConn,
        _core_settings: &Settings,
        _metrics: &Arc<CoreMetrics>,
    ) -> Result<HashMap<String, ()>> {
        todo!()
    }
}

const MESSAGES_LABEL: &str = "messages";

#[derive(Debug, Clone)]
struct SqlOutboxScraper {
    db: DbConn,
    outbox: Arc<dyn Outbox>,
    indexer: Arc<dyn OutboxIndexer>,
    index_settings: IndexSettings,
    metrics: ContractSyncMetrics,
    cursor: Arc<BlockCursor>,
}

impl SqlOutboxScraper {
    pub async fn new(
        db: DbConn,
        outbox: Arc<dyn Outbox>,
        indexer: Arc<dyn OutboxIndexer>,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Result<Self> {
        let cursor = Arc::new(
            BlockCursor::new(
                db.clone(),
                outbox.local_domain(),
                index_settings.from() as u64,
            )
            .await?,
        );
        Ok(Self {
            db,
            outbox,
            indexer,
            index_settings,
            metrics,
            cursor,
        })
    }

    /// Sync outbox messages.
    ///
    /// This code is very similar to the outbox contract sync code in
    /// abacus-base.
    ///
    /// TODO: merge duplicate logic?
    pub async fn sync(self) -> Result<()> {
        use sea_orm::prelude::*;

        let chain_name = self.outbox.chain_name().to_owned();
        let labels = [MESSAGES_LABEL, &chain_name];
        let indexed_height = self.metrics.indexed_height.with_label_values(&labels);
        let stored_messages = self.metrics.stored_events.with_label_values(&labels);
        let missed_messages = self.metrics.missed_events.with_label_values(&labels);
        let message_leaf_index = self.metrics.message_leaf_index.clone();

        let chunk_size = self.index_settings.chunk_size();
        // difference 1
        let mut from = self.cursor.height().await as u32;
        let mut last_valid_range_start_block = from;

        info!(from, chunk_size, chain_name, "Resuming outbox sync");

        loop {
            indexed_height.set(from as i64);

            let tip = if let Ok(num) = self.indexer.get_finalized_block_number().await {
                num
            } else {
                continue;
            };
            if tip <= from {
                sleep(Duration::from_secs(1)).await;
                continue;
            }

            let to = min(tip, from + chunk_size);
            let full_chunk_from = to.checked_sub(chunk_size).unwrap_or_default();
            let mut sorted_messages = self
                .indexer
                .fetch_sorted_messages(full_chunk_from, to)
                .await?;

            info!(
                from = full_chunk_from,
                to,
                message_count = sorted_messages.len(),
                chain_name,
                "Indexed block range for outbox"
            );

            // Difference 2
            let last_leaf_index = self.last_message_leaf_index().await?;
            if let Some(min_index) = last_leaf_index {
                sorted_messages = sorted_messages
                    .into_iter()
                    .filter(|m| m.leaf_index > min_index)
                    .collect();
            }

            debug!(
                from = full_chunk_from,
                to,
                message_count = sorted_messages.len(),
                chain_name,
                "Filtered any messages already indexed for outbox."
            );

            match validate_message_continuity(last_leaf_index, &sorted_messages) {
                ListValidity::Valid => {
                    // Difference 3
                    let max_leaf_index_of_batch = self.store_messages(&sorted_messages).await?;
                    stored_messages.inc_by(sorted_messages.len() as u64);

                    for raw_msg in sorted_messages.iter() {
                        let dst = CommittedMessage::try_from(raw_msg)
                            .ok()
                            .and_then(|msg| name_from_domain_id(msg.message.destination))
                            .unwrap_or_else(|| "unknown".into());
                        message_leaf_index
                            .with_label_values(&["dispatch", &chain_name, &dst])
                            .set(max_leaf_index_of_batch as i64);
                    }

                    // Difference 4
                    self.cursor.update(full_chunk_from as u64).await;
                    last_valid_range_start_block = full_chunk_from;
                    from = to + 1;
                }
                ListValidity::InvalidContinuation => {
                    missed_messages.inc();
                    warn!(
                        ?last_leaf_index,
                        start_block = from,
                        end_block = to,
                        last_valid_range_start_block,
                        chain_name,
                        "Found invalid continuation in range. Re-indexing from the start block of the last successful range."
                    );
                    from = last_valid_range_start_block;
                }
                ListValidity::ContainsGaps => {
                    missed_messages.inc();
                    warn!(
                        ?last_leaf_index,
                        start_block = from,
                        end_block = to,
                        last_valid_range_start_block,
                        chain_name,
                        "Found gaps in the message in range, re-indexing the same range."
                    );
                }
                ListValidity::Empty => from = to + 1,
            }
        }
    }

    async fn last_message_leaf_index(&self) -> Result<Option<u32>> {
        todo!()
    }

    async fn store_messages(&self, messages: &[RawCommittedMessage]) -> Result<u32> {
        todo!()
    }
}

// struct SqlContractSync<I> {
//     chain_name: String,
//     db: DbConn,
//     indexer: I,
//     index_settings: IndexSettings,
//     metrics: ContractSyncMetrics,
// }
