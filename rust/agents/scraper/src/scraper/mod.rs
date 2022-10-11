use std::cmp::min;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::types::H256;
use eyre::{eyre, Context, Result};
use sea_orm::prelude::TimeDateTime;
use sea_orm::{Database, DbConn};
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tracing::instrument::Instrumented;
use tracing::{debug, info, info_span, instrument, trace, warn, Instrument};

use abacus_base::last_message::validate_message_continuity;
use abacus_base::{
    run_all, BaseAgent, ChainSetup, ContractSyncMetrics, CoreMetrics, IndexSettings,
    OutboxAddresses, Settings,
};
use abacus_core::{
    name_from_domain_id, AbacusCommon, AbacusContract, CommittedMessage, ListValidity, LogMeta,
    Outbox, OutboxIndexer, RawCommittedMessage,
};

use crate::scraper::block_cursor::BlockCursor;
use crate::settings::ScraperSettings;
use crate::{format_h256, parse_h256};

mod block_cursor;

/// A message explorer scraper agent
#[derive(Debug)]
#[allow(unused)]
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

    async fn from_settings(settings: Self::Settings, metrics: Arc<CoreMetrics>) -> Result<Self>
    where
        Self: Sized,
    {
        let core_settings: Settings = settings.base;

        let db = Database::connect(&core_settings.db).await?;
        let outboxes = Self::load_outboxes(
            &db,
            &core_settings,
            settings.outboxes,
            &settings.indexes,
            &metrics,
        )
        .await?;
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
        index_settings: &HashMap<String, IndexSettings>,
        metrics: &Arc<CoreMetrics>,
    ) -> Result<HashMap<String, SqlOutboxScraper>> {
        let contract_sync_metrics = ContractSyncMetrics::new(metrics.clone());
        let mut outboxes = HashMap::new();
        for (name, outbox_setup) in config {
            if outbox_setup
                .disabled
                .as_ref()
                .and_then(|d| d.parse::<bool>().ok())
                .unwrap_or(false)
            {
                continue;
            }

            let signer = core_settings.get_signer(&name).await;
            let outbox = outbox_setup.try_into_outbox(signer, metrics).await?;
            let indexer = core_settings
                .try_outbox_indexer_from_config(metrics, &outbox_setup)
                .await?;
            let index_settings_for_chain = index_settings
                .get(outbox.chain_name())
                .ok_or_else(|| eyre!("Index settings are missing for {}", outbox.chain_name()))?;
            outboxes.insert(
                name,
                SqlOutboxScraper::new(
                    db.clone(),
                    outbox.into(),
                    indexer.into(),
                    index_settings_for_chain,
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
        // TODO
        Ok(HashMap::new())
    }

    async fn load_gas_paymasters(
        _db: &DbConn,
        _core_settings: &Settings,
        _metrics: &Arc<CoreMetrics>,
    ) -> Result<HashMap<String, ()>> {
        // TODO
        Ok(HashMap::new())
    }
}

const MESSAGES_LABEL: &str = "messages";

#[derive(Debug, Clone)]
struct SqlOutboxScraper {
    db: DbConn,
    outbox: Arc<dyn Outbox>,
    indexer: Arc<dyn OutboxIndexer>,
    chunk_size: u32,
    metrics: ContractSyncMetrics,
    cursor: Arc<BlockCursor>,
}

impl SqlOutboxScraper {
    pub async fn new(
        db: DbConn,
        outbox: Arc<dyn Outbox>,
        indexer: Arc<dyn OutboxIndexer>,
        index_settings: &IndexSettings,
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
            chunk_size: index_settings.chunk_size(),
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
    /// TODO: better handling for errors to auto-restart without bringing down
    /// the whole service?
    #[instrument]
    pub async fn sync(self) -> Result<()> {
        let chain_name = self.outbox.chain_name();
        let labels = [MESSAGES_LABEL, chain_name];
        let indexed_height = self.metrics.indexed_height.with_label_values(&labels);
        let stored_messages = self.metrics.stored_events.with_label_values(&labels);
        let missed_messages = self.metrics.missed_events.with_label_values(&labels);
        let message_leaf_index = self.metrics.message_leaf_index.clone();

        let chunk_size = self.chunk_size;
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
    #[instrument(skip(self))]
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
    #[instrument(
        level = "debug",
        skip_all,
        fields(messages = ?messages.iter().map(|(_, meta)| meta).collect::<Vec<_>>())
    )]
    async fn store_messages(&self, messages: &[(RawCommittedMessage, LogMeta)]) -> Result<u32> {
        use crate::db::message;
        use sea_orm::{prelude::*, sea_query::OnConflict, ActiveValue::*, Insert};

        debug_assert!(!messages.is_empty());

        let messages = messages
            .iter()
            .map(|(raw, meta)| CommittedMessage::try_from(raw).map(|parsed| (parsed, meta)))
            .collect::<Result<Vec<(CommittedMessage, &LogMeta)>, _>>()
            .context("Failed to parse a message")?;

        // TODO: Look up txn info
        // TODO: Look up block info

        let txns: HashMap<H256, (i64, TimeDateTime)> = self
            .ensure_blocks_and_txns(messages.iter().map(|(_, meta)| *meta))
            .await?
            .collect();

        let max_leaf_id = messages
            .iter()
            .map(|m| m.0.leaf_index)
            .max()
            .ok_or_else(|| eyre!("Received empty list"));
        let models: Vec<_> = messages
            .into_iter()
            .map(|(msg, meta)| {
                debug_assert_eq!(self.outbox.local_domain(), msg.message.origin);
                let (txn_id, txn_timestamp) = txns.get(&meta.transaction_hash).unwrap();
                message::ActiveModel {
                    id: NotSet,
                    time_created: Set(crate::date_time::now()),
                    origin: Unchanged(msg.message.origin as i32),
                    destination: Set(msg.message.destination as i32),
                    leaf_index: Unchanged(msg.leaf_index as i32),
                    sender: Set(format_h256(&msg.message.sender)),
                    recipient: Set(format_h256(&msg.message.recipient)),
                    msg_body: Set(if msg.message.body.is_empty() {
                        None
                    } else {
                        Some(msg.message.body)
                    }),
                    outbox_address: Unchanged(format_h256(&self.outbox.address())),
                    timestamp: Set(*txn_timestamp),
                    origin_tx_id: Set(*txn_id),
                }
            })
            .collect();

        debug_assert!(!models.is_empty());
        trace!(?models, "Writing messages to database");

        Insert::many(models)
            .on_conflict(
                OnConflict::columns([
                    message::Column::OutboxAddress,
                    message::Column::Origin,
                    message::Column::LeafIndex,
                ])
                .update_columns([
                    message::Column::TimeCreated,
                    message::Column::Destination,
                    message::Column::Sender,
                    message::Column::Recipient,
                    message::Column::MsgBody,
                    message::Column::Timestamp,
                    message::Column::OriginTxId,
                ])
                .to_owned(),
            )
            .exec(&self.db)
            .await?;

        max_leaf_id
    }

    /// Takes a list of txn and block hashes and ensure they are all in the
    /// database. If any are not it will fetch the data and insert them.
    ///
    /// Returns a lit of transaction hashes mapping to their database ids.
    async fn ensure_blocks_and_txns(
        &self,
        message_metadata: impl Iterator<Item = &LogMeta>,
    ) -> Result<impl Iterator<Item = (H256, (i64, TimeDateTime))>> {
        let blocks_by_txn_hash: HashMap<H256, H256> = message_metadata
            .map(|meta| (meta.transaction_hash, meta.block_hash))
            .collect();

        // all blocks we care about
        let blocks: HashMap<_, _> = self
            .ensure_blocks(blocks_by_txn_hash.values().copied())
            .await?
            .collect();
        trace!(?blocks, "Ensured blocks");

        // not sure why rust can't detect the lifetimes here are valid, but just
        // wrapping with the Arc/mutex for now.
        let block_timestamps_by_txn: Arc<std::sync::Mutex<HashMap<H256, TimeDateTime>>> =
            Default::default();

        let block_timestamps_by_txn_clone = block_timestamps_by_txn.clone();
        // all txns we care about
        let ids = self
            .ensure_txns(
                blocks_by_txn_hash
                    .into_iter()
                    .map(move |(txn_hash, block_hash)| {
                        let mut block_timestamps_by_txn =
                            block_timestamps_by_txn_clone.lock().unwrap();
                        let block_info = *blocks.get(&block_hash).unwrap();
                        block_timestamps_by_txn.insert(txn_hash, block_info.1);
                        (txn_hash, block_info.0)
                    }),
            )
            .await?;

        Ok(ids.map(move |(txn, id)| {
            (
                txn,
                (
                    id,
                    *block_timestamps_by_txn.lock().unwrap().get(&txn).unwrap(),
                ),
            )
        }))
    }

    // /// Store checkpoints from the outbox into the database. This automatically
    // /// fetches relevant transaction and block data and stores them into the
    // /// database.
    // async fn store_checkpoints(&self, checkpoints: &[(Checkpoint, LogMeta)]) ->
    // Result<()> {     todo!()
    // }

    /// Takes a list of `(transaction_hash, block_id)` and for each transaction
    /// if it is in the database already:
    ///     Fetches its associated ID
    /// if it is not in the database already:
    ///     Looks up its data with ethers and then returns the id after
    ///     inserting it into the database.
    async fn ensure_txns(
        &self,
        txns: impl Iterator<Item = (H256, i64)>,
    ) -> Result<impl Iterator<Item = (H256, i64)>> {
        use crate::db::transaction;
        use sea_orm::{prelude::*, ActiveValue::*, Insert};

        // mapping of txn hash to (txn_id, block_id).
        let mut txns: HashMap<H256, (Option<i64>, i64)> = txns
            .map(|(txn_hash, block_id)| (txn_hash, (None, block_id)))
            .collect();

        let db_txns: Vec<transaction::Model> = if !txns.is_empty() {
            // check database to see which txns we already know and fetch their IDs
            transaction::Entity::find()
                .filter(
                    txns.iter()
                        .map(|(txn, _)| transaction::Column::Hash.eq(format_h256(txn)))
                        .reduce(|acc, i| acc.or(i))
                        .unwrap(),
                )
                .all(&self.db)
                .await?
        } else {
            vec![]
        };
        for txn in db_txns {
            let hash = parse_h256(&txn.hash)?;
            let _ = txns
                .get_mut(&hash)
                .expect("We found a txn that we did not request")
                .0
                .insert(txn.id);
        }

        let txns_to_fetch = txns.iter_mut().filter(|(_, id)| id.0.is_none());
        for (_hash, _txn_info) in txns_to_fetch {
            // TODO: fetch txn data from ethers
        }

        // insert any txns that were not known and get their IDs
        // use this vec as temporary list of mut refs so we can update once we get back
        // the ids.
        let mut txns_to_insert: Vec<(&H256, &mut (Option<i64>, i64))> =
            txns.iter_mut().filter(|(_, id)| id.0.is_none()).collect();
        let models: Vec<transaction::ActiveModel> = txns_to_insert
            .iter()
            .map(|(hash, (_, block_id))| transaction::ActiveModel {
                id: NotSet,
                block_id: Unchanged(*block_id),
                hash: Unchanged(format_h256(hash)),
                time_created: Set(crate::date_time::now()),
                gas_used: Set(Default::default()), // TODO: get this from ethers
                sender: Set("00".to_owned()),      // TODO: get this from ethers
            })
            .collect();

        if !models.is_empty() {
            trace!(?models, "Writing txns to database");
            // so apparently this is actually the ID that was first inserted for postgres?
            let mut cur_id = Insert::many(models).exec(&self.db).await?.last_insert_id;
            for (_hash, (txn_id, _block_id)) in txns_to_insert.iter_mut().rev() {
                debug_assert!(cur_id > 0);
                let _ = txn_id.insert(cur_id);
                cur_id += 1;
            }
        }
        drop(txns_to_insert);

        Ok(txns
            .into_iter()
            .map(|(hash, (txn_id, _block_id))| (hash, txn_id.unwrap())))
    }

    /// Takes a list of block hashes for each block
    /// if it is in the database already:
    ///     Fetches its associated ID
    /// if it is not in the database already:
    ///     Looks up its data with ethers and then returns the id after
    ///     inserting it into the database.
    async fn ensure_blocks(
        &self,
        blocks: impl Iterator<Item = H256>,
    ) -> Result<impl Iterator<Item = (H256, (i64, TimeDateTime))>> {
        use crate::db::block;
        use sea_orm::{prelude::*, ActiveValue::*, Insert};

        type OptionalBlockInfo = Option<(Option<i64>, TimeDateTime)>;
        let mut blocks: HashMap<H256, OptionalBlockInfo> = blocks.map(|b| (b, None)).collect();

        let db_blocks: Vec<block::Model> = if !blocks.is_empty() {
            // check database to see which blocks we already know and fetch their IDs
            block::Entity::find()
                .filter(
                    blocks
                        .iter()
                        .map(|(block, _)| block::Column::Hash.eq(format_h256(block)))
                        .reduce(|acc, i| acc.or(i))
                        .unwrap(),
                )
                .all(&self.db)
                .await?
        } else {
            vec![]
        };

        for block in db_blocks {
            let hash = parse_h256(&block.hash)?;
            let _ = blocks
                .get_mut(&hash)
                .expect("We found a block that we did not request")
                .insert((Some(block.id), block.timestamp));
        }

        let blocks_to_fetch = blocks
            .iter_mut()
            .inspect(|(_, info)| {
                // info being defined implies the id has been set (at this point)
                debug_assert!(info.is_none() || info.unwrap().0.is_some())
            })
            .filter(|(_, block_info)| block_info.is_none());
        for (_hash, block_info) in blocks_to_fetch {
            // TODO: fetch block data from ethers
            let _ = block_info.insert((None, crate::date_time::now()));
        }

        // insert any blocks that were not known and get their IDs
        // use this vec as temporary list of mut refs so we can update once we get back
        // the ids.
        let mut blocks_to_insert: Vec<(&H256, &mut OptionalBlockInfo)> = blocks
            .iter_mut()
            .filter(|(_, info)| info.unwrap().0.is_none())
            .collect();
        let models: Vec<block::ActiveModel> = blocks_to_insert
            .iter_mut()
            .map(|(hash, block_info)| {
                block::ActiveModel {
                    id: NotSet,
                    hash: Set(format_h256(hash)),
                    time_created: Set(crate::date_time::now()),
                    domain: Unchanged(self.outbox.local_domain() as i32),
                    height: Unchanged(0), // TODO: get this from ethers
                    timestamp: Set(block_info.unwrap().1),
                }
            })
            .collect();

        if !models.is_empty() {
            trace!(?models, "Writing blocks to database");
            // so apparently this is actually the ID that was first inserted for postgres?
            let mut cur_id = Insert::many(models).exec(&self.db).await?.last_insert_id;
            for (_hash, block_info) in blocks_to_insert.iter_mut() {
                debug_assert!(cur_id > 0);
                let _ = block_info.as_mut().unwrap().0.insert(cur_id);
                cur_id += 1;
            }
        }

        Ok(blocks.into_iter().map(|(hash, block_info)| {
            let block_info = block_info.unwrap();
            (hash, (block_info.0.unwrap(), block_info.1))
        }))
    }
}

// struct SqlContractSync<I> {
//     chain_name: String,
//     db: DbConn,
//     indexer: I,
//     index_settings: IndexSettings,
//     metrics: ContractSyncMetrics,
// }
