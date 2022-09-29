use std::cmp::min;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::types::H256;
use eyre::{eyre, Context, Result};
use itertools::Itertools;
use sea_orm::{Database, DbConn};
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::instrument::Instrumented;
use tracing::{debug, info, info_span, warn, Instrument};

use crate::db::transaction;
use abacus_base::last_message::validate_message_continuity;
use abacus_base::{
    run_all, BaseAgent, ChainSetup, ContractSyncMetrics, CoreMetrics, IndexSettings,
    OutboxAddresses, Settings,
};
use abacus_core::{
    name_from_domain_id, AbacusCommon, AbacusContract, AbacusMessage, Checkpoint, CommittedMessage,
    ListValidity, LogMeta, Outbox, OutboxIndexer, RawCommittedMessage,
};
use crate::{format_h256, parse_h256};

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

        let chain_name = self.outbox.chain_name();
        let labels = [MESSAGES_LABEL, chain_name];
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
            // TODO: can we avoid querying this each time?
            let last_leaf_index = self.last_message_leaf_index().await?;
            if let Some(min_index) = last_leaf_index {
                sorted_messages = sorted_messages
                    .into_iter()
                    .filter(|m| m.0.leaf_index > min_index)
                    .collect();
            }

            debug!(
                from = full_chunk_from,
                to,
                message_count = sorted_messages.len(),
                chain_name,
                "Filtered any messages already indexed for outbox."
            );

            match validate_message_continuity(
                last_leaf_index,
                &sorted_messages
                    .iter()
                    .map(|(msg, _)| msg)
                    .collect::<Vec<_>>(),
            ) {
                ListValidity::Valid => {
                    // Difference 3
                    let max_leaf_index_of_batch = self.store_messages(&sorted_messages).await?;
                    stored_messages.inc_by(sorted_messages.len() as u64);

                    for (raw_msg, _) in sorted_messages.iter() {
                        let dst = CommittedMessage::try_from(raw_msg)
                            .ok()
                            .and_then(|msg| name_from_domain_id(msg.message.destination))
                            .unwrap_or_else(|| "unknown".into());
                        message_leaf_index
                            .with_label_values(&["dispatch", chain_name, &dst])
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

    // TODO: move these database functions to a database wrapper type?

    /// Get the highest message leaf index that is stored in the database.
    async fn last_message_leaf_index(&self) -> Result<Option<u32>> {
        use crate::db::message;
        use sea_orm::prelude::*;
        use sea_orm::QueryOrder;

        Ok(message::Entity::find()
            .filter(message::Column::Origin.eq(self.outbox.local_domain()))
            .filter(message::Column::OutboxAddress.eq(format_h256(&self.outbox.address())))
            .order_by_desc(message::Column::LeafIndex)
            .one(&self.db)
            .await?
            .map(|m| m.leaf_index as u32))
    }

    /// Store messages from the outbox into the database. This automatically
    /// fetches the relevant transaction and block data and stores them into the
    /// database.
    ///
    /// Returns the highest message leaf index which was provided to this
    /// function.
    async fn store_messages(&self, messages: &[(RawCommittedMessage, LogMeta)]) -> Result<u32> {
        use crate::db::{block, message, transaction};
        use sea_orm::{prelude::*, sea_query::OnConflict, ActiveValue::*, Insert};

        debug_assert!(!messages.is_empty());

        let messages = messages
            .iter()
            .map(|(raw, meta)| CommittedMessage::try_from(raw).map(|parsed| (parsed.message, meta)))
            .collect::<Result<Vec<(AbacusMessage, &LogMeta)>, _>>()
            .context("Failed to parse a message")?;

        // TODO: Look up txn info
        // TODO: Look up block info

        // all txns we care about
        let mut txns = messages
            .iter()
            .map(|(_, meta)| &meta.transaction_hash)
            .collect::<HashSet<_>>();
        // check database to see which txns we already know and fetch their IDs
        if !txns.is_empty() {
            let db_txns: Vec<transaction::Model> = transaction::Entity::find()
                .filter(
                    txns.iter()
                        .map(|txn| transaction::Column::Hash.eq(hex::encode(txn)))
                        .reduce(|acc, i| acc.or(i))
                        .unwrap(),
                )
                .all(&self.db)
                .await?;
            for txn in db_txns {
                let removed = txns.remove(&parse_h256(txn.hash)?);
                debug_assert!(removed);
            }
        }
        // insert any txns that were not known and get their IDs


        todo!()
        // // all blocks we care about
        // let blocks = messages
        //     .iter()
        //     .map(|(_, meta)| &meta.block_hash)
        //     .collect::<HashSet<_>>();
        //
        // let message_models = messages.iter().map(|(raw_msg, parsed_msg)| {
        //     debug_assert_eq!(self.outbox.local_domain(), parsed_msg.origin);
        //     message::ActiveModel {
        //         id: NotSet,
        //         time_created: Set(crate::date_time::now()),
        //         origin: Unchanged(parsed_msg.origin as i32),
        //         destination: Set(parsed_msg.destination as i32),
        //         leaf_index: Unchanged(raw_msg.leaf_index as i32),
        //         sender: Set(parsed_msg.sender),
        //         recipient: Set(parsed_msg.recipient),
        //         msg_body: Set(parsed_msg.body),
        //         outbox_address: Unchanged(self.outbox.address()),
        //         timestamp: Set(block.timestamp),
        //         origin_tx_id: Set(txn_id),
        //     }
        // });
        // Insert::many(message_models)
        //     .on_conflict(
        //         OnConflict::columns([
        //             message::Column::OutboxAddress,
        //             message::Column::Origin,
        //             message::Column::LeafIndex,
        //         ])
        //         .update_columns([
        //             message::Column::TimeCreated,
        //             message::Column::Destination,
        //             message::Column::Sender,
        //             message::Column::Recipient,
        //             message::Column::MsgBody,
        //             message::Column::Timestamp,
        //             message::Column::OriginTxId,
        //         ])
        //         .to_owned(),
        //     )
        //     .exec(&self.db)
        //     .await?;
        //
        // messages
        //     .iter()
        //     .map(|m| m.0.leaf_index)
        //     .max()
        //     .ok_or_else(|| eyre!("Received empty list"))
    }

    /// Store checkpoints from the outbox into the database. This automatically
    /// fetches relevant transaction and block data and stores them into the
    /// database.
    async fn store_checkpoints(&self, checkpoints: &[(Checkpoint, LogMeta)]) -> Result<()> {
        todo!()
    }

    /// Store into the database relevant transactions. These are
    /// blockchain-level transactions that contain events/messages.
    async fn store_txs(&self, txs: &[()]) -> Result<()> {
        todo!()
    }

    /// Store into the database relevant blocks. These are blocks for which we
    /// have at least one relevent transaction.
    async fn store_blocks(&self, blocks: &[()]) -> Result<()> {
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
