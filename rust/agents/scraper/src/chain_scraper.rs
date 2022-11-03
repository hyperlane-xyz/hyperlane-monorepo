use std::cmp::min;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use ethers::types::H256;
use eyre::{eyre, Result};
use sea_orm::prelude::TimeDateTime;
use tokio::time::sleep;
use tracing::{debug, info, instrument, trace, warn};

use abacus_base::last_message::validate_message_continuity;
use abacus_base::{ContractSyncMetrics, IndexSettings};
use abacus_core::{
    name_from_domain_id, AbacusContract, AbacusProvider, BlockInfo, CommittedMessage, Inbox,
    InboxIndexer, ListValidity, LogMeta, Outbox, OutboxIndexer, RawCommittedMessage,
};

use crate::conversions::{format_h256, parse_h256, u256_as_scaled_f64};
use crate::date_time;
use crate::db::{BlockCursor, Delivery, ScraperDb, StorableMessage};

#[derive(Debug, Clone)]
pub struct Remote {
    pub inbox: Arc<dyn Inbox>,
    pub indexer: Arc<dyn InboxIndexer>,
}

#[derive(Debug, Clone)]
pub struct Local {
    pub outbox: Arc<dyn Outbox>,
    pub indexer: Arc<dyn OutboxIndexer>,
    pub provider: Arc<dyn AbacusProvider>,
}

#[derive(Debug, Clone)]
pub struct SqlChainScraper {
    db: ScraperDb,
    /// Contracts on this chain representing this chain (e.g. outbox)
    local: Local,
    /// Contracts on this chain representing remote chains (e.g. inboxes) by
    /// domain of the remote.
    remotes: HashMap<u32, Remote>,
    chunk_size: u32,
    metrics: ContractSyncMetrics,
    cursor: Arc<BlockCursor>,
}

#[allow(unused)]
impl SqlChainScraper {
    pub async fn new(
        db: ScraperDb,
        local: Local,
        remotes: HashMap<u32, Remote>,
        index_settings: &IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Result<Self> {
        let cursor = Arc::new(
            BlockCursor::new(
                db.clone(),
                local.outbox.local_domain(),
                index_settings.from() as u64,
            )
            .await?,
        );
        Ok(Self {
            db,
            local,
            remotes,
            chunk_size: index_settings.chunk_size(),
            metrics,
            cursor,
        })
    }

    pub fn chain_name(&self) -> &str {
        self.local.outbox.chain_name()
    }

    pub fn local_domain(&self) -> u32 {
        self.local.outbox.local_domain()
    }

    pub fn remote_domains(&self) -> impl Iterator<Item = u32> + '_ {
        self.remotes.keys().copied()
    }

    pub async fn get_finalized_block_number(&self) -> Result<u32> {
        self.local.indexer.get_finalized_block_number().await
    }

    /// Sync outbox messages.
    ///
    /// This code is very similar to the outbox contract sync code in
    /// abacus-base.
    ///
    /// TODO: merge duplicate logic?
    /// TODO: better handling for errors to auto-restart without bringing down
    /// the whole service?
    #[instrument(skip(self))]
    pub async fn sync(self) -> Result<()> {
        // TODO: pull this into a fn-like struct for ticks?
        let chain_name = self.chain_name();
        let message_labels = ["messages", chain_name];
        let deliveries_labels = ["deliveries", chain_name];

        let indexed_message_height = self
            .metrics
            .indexed_height
            .with_label_values(&message_labels);
        let indexed_deliveries_height = self
            .metrics
            .indexed_height
            .with_label_values(&deliveries_labels);
        let stored_messages = self
            .metrics
            .stored_events
            .with_label_values(&message_labels);
        let stored_deliveries = self
            .metrics
            .stored_events
            .with_label_values(&deliveries_labels);
        let missed_messages = self
            .metrics
            .missed_events
            .with_label_values(&message_labels);
        let message_leaf_index = self.metrics.message_leaf_index.clone();

        let chunk_size = self.chunk_size;
        let mut from = self.cursor.height().await as u32;
        let mut last_valid_range_start_block = from;
        let mut last_leaf_index = self.last_message_leaf_index().await?.unwrap_or(0);

        info!(from, chunk_size, chain_name, "Resuming chain sync");

        loop {
            indexed_message_height.set(from as i64);
            indexed_deliveries_height.set(from as i64);

            let tip = if let Ok(num) = self.get_finalized_block_number().await {
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
            debug_assert_eq!(self.local.outbox.local_domain(), self.local_domain());
            let mut sorted_messages = self
                .local
                .indexer
                .fetch_sorted_messages(full_chunk_from, to)
                .await?;

            let deliveries: Vec<Delivery> = {
                let mut delivered = vec![];
                for (_, remote) in self.remotes.iter() {
                    debug_assert_eq!(remote.inbox.local_domain(), self.local_domain());
                    delivered.extend(
                        remote
                            .indexer
                            .fetch_processed_messages(full_chunk_from, to)
                            .await?
                            .into_iter()
                            .map(|(message_hash, meta)| Delivery {
                                inbox: remote.inbox.address(),
                                message_hash,
                                meta,
                            }),
                    )
                }
                delivered
            };

            info!(
                from = full_chunk_from,
                to,
                message_count = sorted_messages.len(),
                deliveries_count = deliveries.len(),
                chain_name,
                "Indexed block range for chain"
            );

            sorted_messages = sorted_messages
                .into_iter()
                .filter(|m| m.0.leaf_index > last_leaf_index)
                .collect();

            debug!(
                from = full_chunk_from,
                to,
                message_count = sorted_messages.len(),
                chain_name,
                "Filtered any messages already indexed for outbox."
            );

            match validate_message_continuity(
                Some(last_leaf_index),
                &sorted_messages
                    .iter()
                    .map(|(msg, _)| msg)
                    .collect::<Vec<_>>(),
            ) {
                ListValidity::Valid => {
                    // transaction (database_id, timestamp) by transaction hash
                    let txns: HashMap<H256, (i64, TimeDateTime)> = self
                        .ensure_blocks_and_txns(
                            sorted_messages
                                .iter()
                                .map(|(_, meta)| meta)
                                .chain(deliveries.iter().map(|d| &d.meta)),
                        )
                        .await?
                        .collect();

                    let max_leaf_index_of_batch =
                        self.store_messages(&sorted_messages, &txns).await?;
                    stored_messages.inc_by(sorted_messages.len() as u64);
                    self.record_deliveries(&deliveries, &txns).await?;
                    stored_deliveries.inc_by(deliveries.len() as u64);

                    for (raw_msg, _) in sorted_messages.iter() {
                        let dst = CommittedMessage::try_from(raw_msg)
                            .ok()
                            .and_then(|msg| name_from_domain_id(msg.message.destination))
                            .unwrap_or_else(|| "unknown".into());
                        message_leaf_index
                            .with_label_values(&["dispatch", chain_name, &dst])
                            .set(max_leaf_index_of_batch as i64);
                    }

                    self.cursor.update(full_chunk_from as u64).await;
                    last_leaf_index = max_leaf_index_of_batch;
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
        self.db
            .last_message_leaf_index(self.local_domain(), &self.local.outbox.address())
            .await
    }

    /// Store messages from the outbox into the database.
    ///
    /// Returns the highest message leaf index which was provided to this
    /// function.
    async fn store_messages(
        &self,
        messages: &[(RawCommittedMessage, LogMeta)],
        txns: &HashMap<H256, (i64, TimeDateTime)>,
    ) -> Result<u32> {
        debug_assert!(!messages.is_empty());

        let max_leaf_id = messages
            .iter()
            .map(|m| m.0.leaf_index)
            .max()
            .ok_or_else(|| eyre!("Received empty list"))?;
        let parsed: Vec<(CommittedMessage, &LogMeta)> = messages
            .iter()
            .map(|(raw, meta)| {
                let msg = CommittedMessage::try_from(raw)?;
                debug_assert_eq!(self.local_domain(), msg.message.origin);
                Ok((msg, meta))
            })
            .collect::<Result<_>>()?;
        self.db
            .store_messages(
                &self.local.outbox.address(),
                parsed.into_iter().map(|(msg, meta)| {
                    let (txn_id, txn_timestamp) = txns.get(&meta.transaction_hash).unwrap();
                    StorableMessage {
                        msg,
                        meta,
                        txn_id: *txn_id,
                        timestamp: *txn_timestamp,
                    }
                }),
            )
            .await?;

        Ok(max_leaf_id)
    }

    /// Record that a message was delivered.
    async fn record_deliveries(
        &self,
        deliveries: &[Delivery],
        txns: &HashMap<H256, (i64, TimeDateTime)>,
    ) -> Result<()> {
        if deliveries.is_empty() {
            return Ok(());
        }

        self.db
            .record_deliveries(self.local_domain(), deliveries.iter())
            .await
    }

    /// Takes a list of txn and block hashes and ensure they are all in the
    /// database. If any are not it will fetch the data and insert them.
    ///
    /// Returns a lit of transaction hashes mapping to their database ids.
    async fn ensure_blocks_and_txns(
        &self,
        message_metadata: impl Iterator<Item = &LogMeta>,
    ) -> Result<impl Iterator<Item = (H256, (i64, TimeDateTime))>> {
        let block_hash_by_txn_hash: HashMap<H256, H256> = message_metadata
            .map(|meta| (meta.transaction_hash, meta.block_hash))
            .collect();

        // all blocks we care about
        // hash of block maps to the block id and timestamp
        let blocks: HashMap<_, _> = self
            .ensure_blocks(block_hash_by_txn_hash.values().copied())
            .await?
            .collect();
        trace!(?blocks, "Ensured blocks");

        // not sure why rust can't detect the lifetimes here are valid, but just
        // wrapping with the Arc/mutex for now.
        let block_timestamps_by_txn: Arc<std::sync::Mutex<HashMap<H256, TimeDateTime>>> =
            Default::default();

        let block_timestamps_by_txn_clone = block_timestamps_by_txn.clone();
        // all txns we care about
        let ids =
            self.ensure_txns(block_hash_by_txn_hash.into_iter().map(
                move |(txn_hash, block_hash)| {
                    let mut block_timestamps_by_txn = block_timestamps_by_txn_clone.lock().unwrap();
                    let block_info = *blocks.get(&block_hash).unwrap();
                    block_timestamps_by_txn.insert(txn_hash, block_info.1);
                    (txn_hash, block_info.0)
                },
            ))
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

    /// Takes a list of `(transaction_hash, block_id)` and for each transaction
    /// if it is in the database already:
    ///     Fetches its associated database id
    /// if it is not in the database already:
    ///     Looks up its data with ethers and then returns the database id after
    ///     inserting it into the database.
    async fn ensure_txns(
        &self,
        txns: impl Iterator<Item = (H256, i64)>,
    ) -> Result<impl Iterator<Item = (H256, i64)>> {
        use crate::db::transaction;
        use sea_orm::{prelude::*, ActiveValue::*, Insert, QuerySelect};

        // mapping of txn hash to (txn_id, block_id).
        let mut txns: HashMap<H256, (Option<i64>, i64)> = txns
            .map(|(txn_hash, block_id)| (txn_hash, (None, block_id)))
            .collect();

        let db_txns: Vec<(i64, String)> = if !txns.is_empty() {
            #[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
            enum QueryAs {
                Id,
                Hash,
            }

            // check database to see which txns we already know and fetch their IDs
            transaction::Entity::find()
                .filter(
                    txns.iter()
                        .map(|(txn, _)| transaction::Column::Hash.eq(format_h256(txn)))
                        .reduce(|acc, i| acc.or(i))
                        .unwrap(),
                )
                .select_only()
                .column_as(transaction::Column::Id, QueryAs::Id)
                .column_as(transaction::Column::Hash, QueryAs::Hash)
                .into_values::<_, QueryAs>()
                .all(&self.db)
                .await?
        } else {
            vec![]
        };
        for txn in db_txns {
            let hash = parse_h256(&txn.1)?;
            // insert the txn id now that we have it to the Option value in txns
            let _ = txns
                .get_mut(&hash)
                .expect("We found a txn that we did not request")
                .0
                .insert(txn.0);
        }

        // insert any txns that were not known and get their IDs
        // use this vec as temporary list of mut refs so we can update once we get back
        // the ids.
        let mut txns_to_insert: Vec<(&H256, &mut (Option<i64>, i64))> =
            txns.iter_mut().filter(|(_, id)| id.0.is_none()).collect();

        let mut models: Vec<transaction::ActiveModel> = Vec::with_capacity(txns_to_insert.len());
        let as_f64 = |v: ethers::types::U256| u256_as_scaled_f64(v, 18);
        for (hash, (_, block_id)) in txns_to_insert.iter() {
            let txn = self.local.provider.get_txn_by_hash(hash).await?;
            let receipt = txn
                .receipt
                .as_ref()
                .ok_or_else(|| eyre!("Transaction is not yet included"))?;

            models.push(transaction::ActiveModel {
                id: NotSet,
                block_id: Unchanged(*block_id),
                gas_limit: Set(as_f64(txn.gas_limit)),
                max_priority_fee_per_gas: Set(txn.max_priority_fee_per_gas.map(as_f64)),
                hash: Unchanged(format_h256(hash)),
                time_created: Set(date_time::now()),
                gas_used: Set(as_f64(receipt.gas_used)),
                gas_price: Set(txn.gas_price.map(as_f64)),
                effective_gas_price: Set(receipt.effective_gas_price.map(as_f64)),
                nonce: Set(txn.nonce as i64),
                sender: Set(format_h256(&txn.sender)),
                recipient: Set(txn.recipient.as_ref().map(format_h256)),
                max_fee_per_gas: Set(txn.max_priority_fee_per_gas.map(as_f64)),
                cumulative_gas_used: Set(as_f64(receipt.cumulative_gas_used)),
            });
        }

        if !models.is_empty() {
            trace!(?models, "Writing txns to database");
            // this is actually the ID that was first inserted for postgres
            let mut cur_id = Insert::many(models).exec(&self.db).await?.last_insert_id;
            for (_hash, (txn_id, _block_id)) in txns_to_insert.iter_mut() {
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
    ///     Fetches its associated database id
    /// if it is not in the database already:
    ///     Looks up its data with ethers and then returns the database id after
    ///     inserting it into the database.
    async fn ensure_blocks(
        &self,
        block_hashes: impl Iterator<Item = H256>,
    ) -> Result<impl Iterator<Item = (H256, (i64, TimeDateTime))>> {
        use crate::db::block;
        use sea_orm::{prelude::*, ActiveValue::*, FromQueryResult, Insert, QuerySelect};

        type OptionalBlockInfo = Option<(Option<i64>, BlockInfo)>;
        // mapping of block hash to the database id and block timestamp. Optionals are
        // in place because we will find the timestamp first if the block was not
        // already in the db.
        let mut blocks: HashMap<H256, OptionalBlockInfo> =
            block_hashes.map(|b| (b, None)).collect();

        #[derive(FromQueryResult)]
        struct Block {
            id: i64,
            hash: String,
            timestamp: TimeDateTime,
        }

        let db_blocks: Vec<Block> = if !blocks.is_empty() {
            // check database to see which blocks we already know and fetch their IDs
            block::Entity::find()
                .filter(
                    blocks
                        .iter()
                        .map(|(block, _)| block::Column::Hash.eq(format_h256(block)))
                        .reduce(|acc, i| acc.or(i))
                        .unwrap(),
                )
                .select_only()
                .column_as(block::Column::Id, "id")
                .column_as(block::Column::Hash, "hash")
                .column_as(block::Column::Timestamp, "timestamp")
                .into_model::<Block>()
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
                .insert((
                    Some(block.id),
                    BlockInfo {
                        hash,
                        timestamp: date_time::to_unix_timestamp_s(&block.timestamp),
                        // TODO: we don't actually use these below, we should make sure to clean
                        // this out
                        number: 0,
                        gas_used: Default::default(),
                        gas_limit: Default::default(),
                    },
                ));
        }

        let blocks_to_fetch = blocks
            .iter_mut()
            .inspect(|(_, info)| {
                // info being defined implies the id has been set (at this point)
                debug_assert!(info.is_none() || info.as_ref().unwrap().0.is_some())
            })
            .filter(|(_, block_info)| block_info.is_none());
        for (hash, block_info) in blocks_to_fetch {
            let info = self.local.provider.get_block_by_hash(hash).await?;
            let _ = block_info.insert((None, info));
        }

        // insert any blocks that were not known and get their IDs
        // use this vec as temporary list of mut refs so we can update once we get back
        // the ids.
        let mut blocks_to_insert: Vec<(&H256, &mut OptionalBlockInfo)> = blocks
            .iter_mut()
            .filter(|(_, info)| info.as_ref().unwrap().0.is_none())
            .collect();

        let mut models: Vec<block::ActiveModel> = blocks_to_insert
            .iter()
            .map(|(hash, block_info)| {
                let block_info = block_info.as_ref().unwrap();
                block::ActiveModel {
                    id: NotSet,
                    hash: Set(format_h256(hash)),
                    time_created: Set(date_time::now()),
                    domain: Unchanged(self.local_domain() as i32),
                    height: Unchanged(block_info.1.number as i64),
                    timestamp: Set(date_time::from_unix_timestamp_s(block_info.1.timestamp)),
                    gas_used: Set(u256_as_scaled_f64(block_info.1.gas_used, 18)),
                    gas_limit: Set(u256_as_scaled_f64(block_info.1.gas_limit, 18)),
                }
            })
            .collect();

        if !models.is_empty() {
            trace!(?models, "Writing blocks to database");
            // `last_insert_id` is actually the ID that was first inserted for postgres
            let mut cur_id = Insert::many(models).exec(&self.db).await?.last_insert_id;
            for (_hash, block_info) in blocks_to_insert.iter_mut() {
                debug_assert!(cur_id > 0);
                let _ = block_info.as_mut().unwrap().0.insert(cur_id);
                cur_id += 1;
            }
        }

        Ok(blocks.into_iter().map(|(hash, block_info)| {
            let block_info = block_info.unwrap();
            (
                hash,
                (
                    block_info.0.unwrap(),
                    date_time::from_unix_timestamp_s(block_info.1.timestamp),
                ),
            )
        }))
    }
}
