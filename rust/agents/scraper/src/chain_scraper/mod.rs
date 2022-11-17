//! This module (and children) are responsible for scraping blockchain data and
//! keeping things updated.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use ethers::types::H256;
use eyre::{eyre, Result};
use futures::TryFutureExt;
use hyperlane_base::chains::IndexSettings;
use sea_orm::prelude::TimeDateTime;
use tracing::trace;

use hyperlane_base::ContractSyncMetrics;
use hyperlane_core::{
    BlockInfo, HyperlaneContract, HyperlaneMessage, HyperlaneProvider, LogMeta, Mailbox,
    MailboxIndexer,
};

use crate::chain_scraper::sync::Syncer;
use crate::date_time;
use crate::db::{
    BasicBlock, BlockCursor, ScraperDb, StorableDelivery, StorableMessage, StorableTxn,
};

mod sync;

/// Local chain components like the mailbox.
#[derive(Debug, Clone)]
pub struct Local {
    pub mailbox: Arc<dyn Mailbox>,
    pub indexer: Arc<dyn MailboxIndexer>,
    pub provider: Arc<dyn HyperlaneProvider>,
}

/// A chain scraper is comprised of all the information and contract/provider
/// connections needed to scrape the contracts on a single blockchain.
#[derive(Clone, Debug)]
pub struct SqlChainScraper {
    db: ScraperDb,
    /// Contracts on this chain representing this chain (e.g. mailbox)
    local: Local,
    chunk_size: u32,
    metrics: ContractSyncMetrics,
    cursor: Arc<BlockCursor>,
}

#[allow(unused)]
impl SqlChainScraper {
    pub async fn new(
        db: ScraperDb,
        local: Local,
        index_settings: &IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Result<Self> {
        let cursor = Arc::new(
            db.block_cursor(local.mailbox.local_domain(), index_settings.from() as u64)
                .await?,
        );
        Ok(Self {
            db,
            local,
            chunk_size: index_settings.chunk_size(),
            metrics,
            cursor,
        })
    }

    pub fn chain_name(&self) -> &str {
        self.local.mailbox.chain_name()
    }

    pub fn local_domain(&self) -> u32 {
        self.local.mailbox.local_domain()
    }

    pub async fn get_finalized_block_number(&self) -> Result<u32> {
        self.local.indexer.get_finalized_block_number().await
    }

    /// Sync contract data and other blockchain with the current chain state.
    /// This will create a long-running task that should be spawned.
    pub fn sync(self) -> impl Future<Output = Result<()>> + Send + 'static {
        Syncer::new(self).and_then(|syncer| syncer.run())
    }

    /// Fetch the highest message nonce we have seen for the local domain.
    async fn last_message_nonce(&self) -> Result<Option<u32>> {
        self.db
            .last_message_nonce(self.local_domain(), &self.local.mailbox.address())
            .await
    }

    /// Store messages from the origin mailbox into the database.
    ///
    /// Returns the highest message nonce which was provided to this
    /// function.
    async fn store_messages(
        &self,
        messages: &[HyperlaneMessageWithMeta],
        txns: &HashMap<H256, TxnWithIdAndTime>,
    ) -> Result<u32> {
        debug_assert!(!messages.is_empty());

        let max_nonce = messages
            .iter()
            .map(|m| m.message.nonce)
            .max()
            .ok_or_else(|| eyre!("Received empty list"))?;
        self.db
            .store_messages(
                &self.local.mailbox.address(),
                messages.iter().map(|m| {
                    let txn = txns.get(&m.meta.transaction_hash).unwrap();
                    StorableMessage {
                        msg: m.message.clone(),
                        meta: &m.meta,
                        txn_id: txn.id,
                        timestamp: txn.timestamp,
                    }
                }),
            )
            .await?;

        Ok(max_nonce)
    }

    /// Record that a message was delivered.
    async fn store_deliveries(
        &self,
        deliveries: &[Delivery],
        txns: &HashMap<H256, TxnWithIdAndTime>,
    ) -> Result<()> {
        if deliveries.is_empty() {
            return Ok(());
        }

        let storable = deliveries.iter().map(|delivery| {
            let txn_id = txns.get(&delivery.meta.transaction_hash).unwrap().id;
            delivery.as_storable(txn_id)
        });

        self.db
            .store_deliveries(self.local_domain(), storable)
            .await
    }

    /// Takes a list of txn and block hashes and ensure they are all in the
    /// database. If any are not it will fetch the data and insert them.
    ///
    /// Returns the relevant transaction info.
    async fn ensure_blocks_and_txns(
        &self,
        message_metadata: impl Iterator<Item = &LogMeta>,
    ) -> Result<impl Iterator<Item = TxnWithIdAndTime>> {
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
        let txns_with_ids =
            self.ensure_txns(block_hash_by_txn_hash.into_iter().map(
                move |(txn_hash, block_hash)| {
                    let mut block_timestamps_by_txn = block_timestamps_by_txn_clone.lock().unwrap();
                    let block_info = *blocks.get(&block_hash).as_ref().unwrap();
                    block_timestamps_by_txn.insert(txn_hash, block_info.timestamp);
                    TxnWithBlockId {
                        txn_hash,
                        block_id: block_info.id,
                    }
                },
            ))
            .await?;

        Ok(
            txns_with_ids.map(move |TxnWithId { hash, id: txn_id }| TxnWithIdAndTime {
                hash,
                id: txn_id,
                timestamp: *block_timestamps_by_txn.lock().unwrap().get(&hash).unwrap(),
            }),
        )
    }

    /// Takes a list of transaction hashes and the block id the transaction is
    /// in. if it is in the database already:
    ///     Fetches its associated database id
    /// if it is not in the database already:
    ///     Looks up its data with ethers and then returns the database id after
    ///     inserting it into the database.
    async fn ensure_txns(
        &self,
        txns: impl Iterator<Item = TxnWithBlockId>,
    ) -> Result<impl Iterator<Item = TxnWithId>> {
        // mapping of txn hash to (txn_id, block_id).
        let mut txns: HashMap<H256, (Option<i64>, i64)> = txns
            .map(|TxnWithBlockId { txn_hash, block_id }| (txn_hash, (None, block_id)))
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
        let as_f64 = ethers::types::U256::to_f64_lossy;
        for (hash, (_, block_id)) in txns_to_insert.iter() {
            storable.push(StorableTxn {
                info: self.local.provider.get_txn_by_hash(hash).await?,
                block_id: *block_id,
            });
        }

        if !storable.is_empty() {
            let mut cur_id = self.db.store_txns(storable.into_iter()).await?;
            for (_hash, (txn_id, _block_id)) in txns_to_insert.iter_mut() {
                debug_assert!(cur_id > 0);
                let _ = txn_id.insert(cur_id);
                cur_id += 1;
            }
        }
        drop(txns_to_insert);

        Ok(txns
            .into_iter()
            .map(|(hash, (txn_id, _block_id))| TxnWithId {
                hash,
                id: txn_id.unwrap(),
            }))
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
        // mapping of block hash to the database id and block timestamp. Optionals are
        // in place because we will find the timestamp first if the block was not
        // already in the db.
        let mut blocks: HashMap<H256, Option<BasicBlock>> =
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

        if !blocks_to_insert.is_empty() {
            let mut cur_id = self
                .db
                .store_blocks(
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

#[derive(Debug, Clone)]
struct Delivery {
    destination_mailbox: H256,
    message_id: H256,
    meta: LogMeta,
}

impl Delivery {
    fn as_storable(&self, txn_id: i64) -> StorableDelivery {
        StorableDelivery {
            destination_mailbox: self.destination_mailbox,
            message_id: self.message_id,
            meta: &self.meta,
            txn_id,
        }
    }
}

#[derive(Debug, Clone)]
struct TxnWithIdAndTime {
    hash: H256,
    id: i64,
    timestamp: TimeDateTime,
}

#[derive(Debug, Clone)]
struct TxnWithId {
    hash: H256,
    id: i64,
}

#[derive(Debug, Clone)]
struct TxnWithBlockId {
    txn_hash: H256,
    block_id: i64,
}

#[derive(Debug, Clone)]
struct HyperlaneMessageWithMeta {
    message: HyperlaneMessage,
    meta: LogMeta,
}
