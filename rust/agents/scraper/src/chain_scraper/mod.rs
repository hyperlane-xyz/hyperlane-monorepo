use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use ethers::types::H256;
use eyre::{eyre, Result};
use futures::TryFutureExt;
use sea_orm::prelude::TimeDateTime;
use tracing::{instrument, trace};

use abacus_base::{ContractSyncMetrics, IndexSettings};
use abacus_core::{
    AbacusContract, AbacusProvider, BlockInfo, CommittedMessage, Inbox, InboxIndexer, LogMeta,
    Outbox, OutboxIndexer, RawCommittedMessage,
};

use crate::chain_scraper::sync::Syncer;
use crate::conversions::u256_as_scaled_f64;
use crate::date_time;
use crate::db::{
    BasicBlock, BlockCursor, ScraperDb, StorableDelivery, StorableMessage, StorableTxn,
};

mod sync;

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
struct Delivery {
    pub inbox: H256,
    pub message_hash: H256,
    pub meta: LogMeta,
}

impl Delivery {
    fn as_storable(&self, txn_id: i64) -> StorableDelivery {
        StorableDelivery {
            inbox: self.inbox,
            message_hash: self.message_hash,
            meta: &self.meta,
            txn_id,
        }
    }
}

#[derive(Clone, Debug)]
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
            db.block_cursor(local.outbox.local_domain(), index_settings.from() as u64)
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
    pub fn sync(self) -> impl Future<Output = Result<()>> + Send + 'static {
        Syncer::new(self).and_then(|syncer| syncer.run())
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

        let storable = deliveries.iter().map(|delivery| {
            let txn_id = txns.get(&delivery.meta.transaction_hash).unwrap().0;
            delivery.as_storable(txn_id)
        });

        self.db
            .record_deliveries(self.local_domain(), storable)
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
            .into_iter()
            .map(|block| (block.hash, block))
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
                    let block_info = *blocks.get(&block_hash).as_ref().unwrap();
                    block_timestamps_by_txn.insert(txn_hash, block_info.timestamp);
                    (txn_hash, block_info.id)
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
        // mapping of txn hash to (txn_id, block_id).
        let mut txns: HashMap<H256, (Option<i64>, i64)> = txns
            .map(|(txn_hash, block_id)| (txn_hash, (None, block_id)))
            .collect();

        let db_txns = if !txns.is_empty() {
            self.db.get_txn_ids(txns.keys()).await?
        } else {
            HashMap::new()
        };
        for (hash, id) in db_txns {
            // insert the txn id now that we have it to the Option value in txns
            let _ = txns
                .get_mut(&hash)
                .expect("We found a txn that we did not request")
                .0
                .insert(id);
        }

        // insert any txns that were not known and get their IDs
        // use this vec as temporary list of mut refs so we can update once we get back
        // the ids.
        let mut txns_to_insert: Vec<(&H256, &mut (Option<i64>, i64))> =
            txns.iter_mut().filter(|(_, id)| id.0.is_none()).collect();

        let mut storable: Vec<StorableTxn> = Vec::with_capacity(txns_to_insert.len());
        let as_f64 = |v: ethers::types::U256| u256_as_scaled_f64(v, 18);
        for (hash, (_, block_id)) in txns_to_insert.iter() {
            storable.push(StorableTxn {
                info: self.local.provider.get_txn_by_hash(hash).await?,
                block_id: *block_id,
            });
        }

        if !storable.is_empty() {
            let mut cur_id = self.db.record_txns(storable.into_iter()).await?;
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
    ) -> Result<impl Iterator<Item = BasicBlock>> {
        type OptionalBlockInfo = Option<BasicBlock>;
        // mapping of block hash to the database id and block timestamp. Optionals are
        // in place because we will find the timestamp first if the block was not
        // already in the db.
        let mut blocks: HashMap<H256, OptionalBlockInfo> =
            block_hashes.map(|b| (b, None)).collect();

        let db_blocks: Vec<BasicBlock> = if !blocks.is_empty() {
            // check database to see which blocks we already know and fetch their IDs
            self.db
                .get_block_basic(blocks.iter().map(|(hash, _)| hash))
                .await?
        } else {
            vec![]
        };

        for block in db_blocks {
            let _ = blocks
                .get_mut(&block.hash)
                .expect("We found a block that we did not request")
                .insert(block);
        }

        // insert any blocks that were not known and get their IDs
        // use this vec as temporary list of mut refs so we can update their ids once we
        // have inserted them into the database.
        // Block info is an option so we can move it, must always be Some before
        // inserted into db.
        let mut blocks_to_insert: Vec<(&mut BasicBlock, Option<BlockInfo>)> = vec![];
        let blocks_to_fetch = blocks
            .iter_mut()
            .filter(|(_, block_info)| block_info.is_none());
        for (hash, block_info) in blocks_to_fetch {
            let info = self.local.provider.get_block_by_hash(hash).await?;
            let basic_info_ref = block_info.insert(BasicBlock {
                id: -1,
                hash: *hash,
                timestamp: date_time::from_unix_timestamp_s(info.timestamp),
            });
            blocks_to_insert.push((basic_info_ref, Some(info)));
        }

        let mut cur_id = self
            .db
            .record_blocks(
                self.local_domain(),
                blocks_to_insert
                    .iter_mut()
                    .map(|(_, info)| info.take().unwrap()),
            )
            .await?;
        for (block_ref, _) in blocks_to_insert.into_iter() {
            block_ref.id = cur_id;
            cur_id += 1;
        }

        // ensure we have updated all the block ids and that we have info for all of
        // them.
        #[cfg(debug_assertions)]
        for (hash, block) in blocks.iter() {
            let block = block.as_ref().unwrap();
            assert_eq!(hash, &block.hash);
            assert!(block.id > 0);
        }

        Ok(blocks
            .into_iter()
            .map(|(hash, block_info)| block_info.unwrap()))
    }
}
