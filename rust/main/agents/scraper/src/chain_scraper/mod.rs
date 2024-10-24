#![allow(clippy::unnecessary_fallible_conversions)] // TODO: `rustc` 1.80.1 clippy issue

//! This module (and children) are responsible for scraping blockchain data and
//! keeping things updated.

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use eyre::Result;
use itertools::Itertools;
use tracing::{trace, warn};

use hyperlane_base::settings::IndexSettings;
use hyperlane_core::{
    unwrap_or_none_result, BlockId, BlockInfo, Delivery, HyperlaneDomain, HyperlaneLogStore,
    HyperlaneMessage, HyperlaneProvider, HyperlaneSequenceAwareIndexerStoreReader,
    HyperlaneWatermarkedLogStore, Indexed, InterchainGasPayment, LogMeta, H256, H512,
};

use crate::db::{
    BasicBlock, BlockCursor, ScraperDb, StorableDelivery, StorableMessage, StorablePayment,
    StorableTxn,
};

/// Maximum number of records to query at a time. This came about because when a
/// lot of messages are sent in a short period of time we were ending up with a
/// lot of data to query from the node provider between points when we would
/// actually save it to the database.
const CHUNK_SIZE: usize = 50;

/// A chain scraper is comprised of all the information and contract/provider
/// connections needed to scrape the contracts on a single blockchain.
#[derive(Clone, Debug)]
pub struct HyperlaneSqlDb {
    mailbox_address: H256,
    domain: HyperlaneDomain,
    db: ScraperDb,
    provider: Arc<dyn HyperlaneProvider>,
    cursor: Arc<BlockCursor>,
}

#[allow(unused)]
impl HyperlaneSqlDb {
    pub async fn new(
        db: ScraperDb,
        mailbox_address: H256,
        domain: HyperlaneDomain,
        provider: Arc<dyn HyperlaneProvider>,
        index_settings: &IndexSettings,
    ) -> Result<Self> {
        let cursor = Arc::new(
            db.block_cursor(domain.id(), index_settings.from as u64)
                .await?,
        );
        Ok(Self {
            db,
            domain,
            provider,
            mailbox_address,
            cursor,
        })
    }

    pub fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    pub async fn last_message_nonce(&self) -> Result<Option<u32>> {
        self.db
            .last_message_nonce(self.domain.id(), &self.mailbox_address)
            .await
    }

    /// Takes a list of txn and block hashes and ensure they are all in the
    /// database. If any are not it will fetch the data and insert them.
    ///
    /// Returns the relevant transaction info.
    async fn ensure_blocks_and_txns(
        &self,
        log_meta: impl Iterator<Item = &LogMeta>,
    ) -> Result<impl Iterator<Item = TxnWithId>> {
        let block_id_by_txn_hash: HashMap<H512, BlockId> = log_meta
            .map(|meta| {
                (
                    meta.transaction_id,
                    BlockId::new(meta.block_hash, meta.block_number),
                )
            })
            .collect();

        // all blocks we care about
        // hash of block maps to the block id and timestamp
        let blocks: HashMap<_, _> = self
            .ensure_blocks(block_id_by_txn_hash.values().copied())
            .await?
            .map(|block| (block.hash, block))
            .collect();
        trace!(?blocks, "Ensured blocks");

        // We ensure transactions only from blocks which are inserted into database
        let txn_hash_with_block_ids = block_id_by_txn_hash
            .into_iter()
            .filter_map(move |(txn, block)| blocks.get(&block.hash).map(|b| (txn, b.id)))
            .map(|(txn_hash, block_id)| TxnWithBlockId { txn_hash, block_id });
        let txns_with_ids = self.ensure_txns(txn_hash_with_block_ids).await?;

        Ok(txns_with_ids.map(move |TxnWithId { hash, id: txn_id }| TxnWithId { hash, id: txn_id }))
    }

    /// Takes a list of transaction hashes and the block id the transaction is
    /// in. if it is in the database already:
    ///     Fetches its associated database id
    /// if it is not in the database already:
    ///     Looks up its data with the chain and then returns the database id after
    ///     inserting it into the database.
    /// if it cannot fetch and parse transaction, the transaction will be skipped and not returned
    /// from this method.
    async fn ensure_txns(
        &self,
        txns: impl Iterator<Item = TxnWithBlockId>,
    ) -> Result<impl Iterator<Item = TxnWithId>> {
        // mapping of txn hash to (txn_id, block_id).
        let mut txns: HashMap<H512, (Option<i64>, i64)> = txns
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
        let mut txns_to_fetch = txns.iter_mut().filter(|(_, id)| id.0.is_none());

        let mut txns_to_insert: Vec<StorableTxn> = Vec::with_capacity(CHUNK_SIZE);
        let mut hashes_to_insert: Vec<&H512> = Vec::with_capacity(CHUNK_SIZE);

        for mut chunk in as_chunks::<(&H512, &mut (Option<i64>, i64))>(txns_to_fetch, CHUNK_SIZE) {
            for (hash, (_, block_id)) in chunk.iter() {
                let info = match self.provider.get_txn_by_hash(hash).await {
                    Ok(info) => info,
                    Err(e) => {
                        warn!(?hash, ?e, "error fetching and parsing transaction");
                        continue;
                    }
                };
                hashes_to_insert.push(*hash);
                txns_to_insert.push(StorableTxn {
                    info,
                    block_id: *block_id,
                });
            }

            // If we have no transactions to insert, we don't need to store them and update
            // database transaction ids.
            if txns_to_insert.is_empty() {
                continue;
            }

            self.db.store_txns(txns_to_insert.drain(..)).await?;
            let ids = self.db.get_txn_ids(hashes_to_insert.drain(..)).await?;

            for (hash, (txn_id, _block_id)) in chunk.iter_mut() {
                *txn_id = ids.get(hash).copied();
            }
        }

        let ensured_txns = txns
            .into_iter()
            .filter_map(|(hash, (txn_id, _))| txn_id.map(|id| (hash, id)))
            .map(|(hash, id)| TxnWithId { hash, id });

        Ok(ensured_txns)
    }

    /// Takes a list of block hashes for each block
    /// if it is in the database already:
    ///     Fetches its associated database id
    /// if it is not in the database already:
    ///     Looks up its data with the chain and then returns the database id after
    ///     inserting it into the database.
    /// if it cannot fetch and parse block, the block will be skipped and not returned from
    /// this method.
    async fn ensure_blocks(
        &self,
        block_ids: impl Iterator<Item = BlockId>,
    ) -> Result<impl Iterator<Item = BasicBlock>> {
        // Mapping from block hash to block ids (hash and height)
        let block_hash_to_block_id_map: HashMap<H256, BlockId> =
            block_ids.map(|b| (b.hash, b)).collect();

        // Mapping of block hash to `BasicBlock` which contains database block id and block hash.
        let mut blocks: HashMap<H256, Option<BasicBlock>> = block_hash_to_block_id_map
            .keys()
            .map(|hash| (*hash, None))
            .collect();

        let db_blocks: Vec<BasicBlock> = if !blocks.is_empty() {
            // check database to see which blocks we already know and fetch their IDs
            self.db.get_block_basic(blocks.keys()).await?
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
        let blocks_to_fetch = blocks
            .iter_mut()
            .filter(|(_, block_info)| block_info.is_none());

        let mut blocks_to_insert: Vec<(&mut BasicBlock, Option<BlockInfo>)> =
            Vec::with_capacity(CHUNK_SIZE);
        let mut hashes_to_insert: Vec<&H256> = Vec::with_capacity(CHUNK_SIZE);
        for chunk in as_chunks(blocks_to_fetch, CHUNK_SIZE) {
            debug_assert!(!chunk.is_empty());
            for (hash, block_info) in chunk {
                // We should have block_id in this map for every hashes
                let block_id = block_hash_to_block_id_map[hash];
                let block_height = block_id.height;

                let info = match self.provider.get_block_by_height(block_height).await {
                    Ok(info) => info,
                    Err(e) => {
                        warn!(block_hash = ?hash, ?block_height, ?e, "error fetching and parsing block");
                        continue;
                    }
                };
                let basic_info_ref = block_info.insert(BasicBlock {
                    id: -1,
                    hash: *hash,
                });
                blocks_to_insert.push((basic_info_ref, Some(info)));
                hashes_to_insert.push(hash);
            }

            // If we have no blocks to insert, we don't store them and we don't update
            // database block ids.
            if blocks_to_insert.is_empty() {
                continue;
            }

            self.db
                .store_blocks(
                    self.domain().id(),
                    blocks_to_insert
                        .iter_mut()
                        .map(|(_, info)| info.take().unwrap()),
                )
                .await?;

            let hashes = self
                .db
                .get_block_basic(hashes_to_insert.drain(..))
                .await?
                .into_iter()
                .map(|b| (b.hash, b.id))
                .collect::<HashMap<_, _>>();

            for (block_ref, _) in blocks_to_insert.drain(..) {
                if let Some(id) = hashes.get(&block_ref.hash) {
                    block_ref.id = *id;
                }
            }
        }

        let ensured_blocks = blocks
            .into_iter()
            .filter_map(|(hash, block_info)| block_info.filter(|b| b.id != -1));

        Ok(ensured_blocks)
    }
}

#[async_trait]
impl HyperlaneLogStore<HyperlaneMessage> for HyperlaneSqlDb {
    /// Store dispatched messages from the origin mailbox into the database.
    /// We store only messages from blocks and transaction which we could successfully insert
    /// into database.
    async fn store_logs(&self, messages: &[(Indexed<HyperlaneMessage>, LogMeta)]) -> Result<u32> {
        if messages.is_empty() {
            return Ok(0);
        }
        let txns: HashMap<H512, TxnWithId> = self
            .ensure_blocks_and_txns(messages.iter().map(|r| &r.1))
            .await?
            .map(|t| (t.hash, t))
            .collect();
        let storable = messages
            .iter()
            .filter_map(|(message, meta)| {
                txns.get(
                    &meta
                        .transaction_id
                        .try_into()
                        .expect("256-bit transaction ids are the maximum supported at this time"),
                )
                .map(|t| (message.inner().clone(), meta, t.id))
            })
            .map(|(msg, meta, txn_id)| StorableMessage { msg, meta, txn_id });
        let stored = self
            .db
            .store_dispatched_messages(self.domain().id(), &self.mailbox_address, storable)
            .await?;
        Ok(stored as u32)
    }
}

#[async_trait]
impl HyperlaneLogStore<Delivery> for HyperlaneSqlDb {
    /// Store delivered message ids from the destination mailbox into the database.
    /// We store only delivered messages ids from blocks and transaction which we could successfully
    /// insert into database.
    async fn store_logs(&self, deliveries: &[(Indexed<Delivery>, LogMeta)]) -> Result<u32> {
        if deliveries.is_empty() {
            return Ok(0);
        }
        let txns: HashMap<H512, TxnWithId> = self
            .ensure_blocks_and_txns(deliveries.iter().map(|r| &r.1))
            .await?
            .map(|t| (t.hash, t))
            .collect();
        let storable = deliveries
            .iter()
            .filter_map(|(message_id, meta)| {
                txns.get(
                    &meta
                        .transaction_id
                        .try_into()
                        .expect("256-bit transaction ids are the maximum supported at this time"),
                )
                .map(|txn| (*message_id.inner(), meta, txn.id))
            })
            .map(|(message_id, meta, txn_id)| StorableDelivery {
                message_id,
                meta,
                txn_id,
            });

        let stored = self
            .db
            .store_deliveries(self.domain().id(), self.mailbox_address, storable)
            .await?;
        Ok(stored as u32)
    }
}

#[async_trait]
impl HyperlaneLogStore<InterchainGasPayment> for HyperlaneSqlDb {
    /// Store interchain gas payments into the database.
    /// We store only interchain gas payments from blocks and transaction which we could
    /// successfully insert into database.
    async fn store_logs(
        &self,
        payments: &[(Indexed<InterchainGasPayment>, LogMeta)],
    ) -> Result<u32> {
        if payments.is_empty() {
            return Ok(0);
        }
        let txns: HashMap<H512, TxnWithId> = self
            .ensure_blocks_and_txns(payments.iter().map(|r| &r.1))
            .await?
            .map(|t| (t.hash, t))
            .collect();
        let storable = payments
            .iter()
            .filter_map(|(payment, meta)| {
                txns.get(
                    &meta
                        .transaction_id
                        .try_into()
                        .expect("256-bit transaction ids are the maximum supported at this time"),
                )
                .map(|txn| (payment.inner(), meta, txn.id))
            })
            .map(|(payment, meta, txn_id)| StorablePayment {
                payment,
                meta,
                txn_id,
            });

        let stored = self.db.store_payments(self.domain().id(), storable).await?;
        Ok(stored as u32)
    }
}

#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<HyperlaneMessage> for HyperlaneSqlDb {
    /// Gets a message by its nonce.
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<HyperlaneMessage>> {
        let message = self
            .db
            .retrieve_message_by_nonce(self.domain().id(), &self.mailbox_address, sequence)
            .await?;
        Ok(message)
    }

    /// Gets the block number at which the log occurred.
    async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> Result<Option<u64>> {
        let tx_id = unwrap_or_none_result!(
            self.db
                .retrieve_dispatched_tx_id(self.domain().id(), &self.mailbox_address, sequence)
                .await?
        );
        let block_id = unwrap_or_none_result!(self.db.retrieve_block_id(tx_id).await?);
        Ok(self.db.retrieve_block_number(block_id).await?)
    }
}

#[async_trait]
impl<T> HyperlaneWatermarkedLogStore<T> for HyperlaneSqlDb
where
    HyperlaneSqlDb: HyperlaneLogStore<T>,
{
    /// Gets the block number high watermark
    async fn retrieve_high_watermark(&self) -> Result<Option<u32>> {
        Ok(Some(self.cursor.height().await.try_into()?))
    }
    /// Stores the block number high watermark
    async fn store_high_watermark(&self, block_number: u32) -> Result<()> {
        self.cursor.update(block_number.into()).await;
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct TxnWithId {
    hash: H512,
    id: i64,
}

#[derive(Debug, Clone)]
struct TxnWithBlockId {
    txn_hash: H512,
    block_id: i64,
}

fn as_chunks<T>(iter: impl Iterator<Item = T>, chunk_size: usize) -> impl Iterator<Item = Vec<T>> {
    // the itertools chunks function uses refcell which cannot be used across an
    // await so this stabilizes the result by putting it into a vec of vecs and
    // using that for iteration.
    iter.chunks(chunk_size)
        .into_iter()
        .map(|chunk| chunk.into_iter().collect())
        .collect_vec()
        .into_iter()
}
