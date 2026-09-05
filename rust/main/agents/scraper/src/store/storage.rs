#![allow(clippy::unnecessary_fallible_conversions)] // TODO: `rustc` 1.80.1 clippy issue

//! This module (and children) are responsible for scraping blockchain data and
//! keeping things updated.

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use eyre::Result;
use prometheus::IntCounterVec;
use tracing::{trace, warn};

use hyperlane_base::settings::{CoreContractAddresses, IndexSettings};
use hyperlane_core::{
    BlockId, BlockInfo, HyperlaneDomain, HyperlaneLogStore, HyperlaneProvider,
    HyperlaneWatermarkedLogStore, LogMeta, H256, H512,
};

use crate::db::{BasicBlock, BlockCursor, ScraperDb, StorableTxn};

/// Maximum number of records to query at a time. This came about because when a
/// lot of messages are sent in a short period of time we were ending up with a
/// lot of data to query from the node provider between points when we would
/// actually save it to the database.
const CHUNK_SIZE: usize = 50;

/// A chain scraper is comprised of all the information and contract/provider
/// connections needed to scrape the contracts on a single blockchain.
#[derive(Clone, Debug)]
pub struct HyperlaneDbStore {
    pub(crate) db: ScraperDb,
    pub(crate) domain: HyperlaneDomain,
    pub(crate) mailbox_address: H256,
    pub(crate) interchain_gas_paymaster_address: H256,
    pub(crate) merkle_tree_hook_address: H256,
    provider: Arc<dyn HyperlaneProvider>,
    cursor: Arc<BlockCursor>,
    /// Metric for tracking raw message dispatches stored (used for CCTP availability)
    stored_events_metric: Option<IntCounterVec>,
}

#[allow(unused)]
impl HyperlaneDbStore {
    pub async fn new(
        db: ScraperDb,
        domain: HyperlaneDomain,
        addresses: CoreContractAddresses,
        provider: Arc<dyn HyperlaneProvider>,
        index_settings: &IndexSettings,
        stored_events_metric: Option<IntCounterVec>,
    ) -> Result<Self> {
        let cursor = Arc::new(
            db.block_cursor(domain.id(), "", index_settings.from as u64)
                .await?,
        );
        Ok(Self {
            db,
            domain,
            mailbox_address: addresses.mailbox,
            interchain_gas_paymaster_address: addresses.interchain_gas_paymaster,
            merkle_tree_hook_address: addresses.merkle_tree_hook,
            provider,
            cursor,
            stored_events_metric,
        })
    }

    /// Get the stored events metric for incrementing when raw messages are stored.
    pub fn stored_events_metric(&self) -> Option<&IntCounterVec> {
        self.stored_events_metric.as_ref()
    }

    /// Takes a list of txn and block hashes and ensure they are all in the
    /// database. If any are not it will fetch the data and insert them.
    ///
    /// Returns the relevant transaction info.
    ///
    /// Log metas with zero transaction and block hashes (produced by indexers
    /// that cannot resolve either, e.g. the Sealevel basic log meta fallback)
    /// carry no fetchable block/transaction data and are skipped here; callers
    /// must still persist those events with a NULL transaction relation.
    pub(crate) async fn ensure_blocks_and_txns(
        &self,
        log_meta: impl Iterator<Item = &LogMeta>,
    ) -> Result<impl Iterator<Item = (H512, i64)>> {
        let block_id_by_txn_hash: HashMap<H512, BlockId> = log_meta
            .filter(|meta| !meta.transaction_id.is_zero() && !meta.block_hash.is_zero())
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
            .map(|block| (block.hash, block.id))
            .collect();
        trace!(?blocks, "Ensured blocks");

        // We ensure transactions only from blocks which are inserted into database
        let txn_hash_with_block_ids = block_id_by_txn_hash
            .into_iter()
            .filter_map(move |(txn, block)| blocks.get(&block.hash).map(|id| (txn, *id)))
            .map(|(txn_hash, block_id)| TxnWithBlockId { txn_hash, block_id });
        let txns_with_ids = self.ensure_txns(txn_hash_with_block_ids).await?;

        Ok(txns_with_ids)
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
    ) -> Result<impl Iterator<Item = (H512, i64)>> {
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
            for (hash, (_, block_id)) in chunk.iter().filter(|(hash, _)| !hash.is_zero()) {
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
            .filter_map(|(hash, (txn_id, _))| txn_id.map(|id| (hash, id)));

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
        // Keep the requested height beside its enrichment state. Duplicate
        // hashes retain the last height, matching the input metadata map.
        let mut blocks: HashMap<H256, (u64, Option<i64>)> = block_ids
            .map(|block| (block.hash, (block.height, None)))
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
                .1
                .insert(block.id);
        }

        // insert any blocks that were not known and get their IDs
        // use this vec as temporary list of mut refs so we can update their ids once we
        // have inserted them into the database.
        // A temporary -1 id is excluded from the result unless the inserted
        // block hash resolves to a database id on readback.
        let blocks_to_fetch = blocks
            .iter_mut()
            .filter(|(_, (_, stored_id))| stored_id.is_none());

        for chunk in as_chunks(blocks_to_fetch, CHUNK_SIZE) {
            debug_assert!(!chunk.is_empty());
            let mut block_infos: Vec<BlockInfo> = Vec::with_capacity(CHUNK_SIZE);
            let mut blocks_to_insert: Vec<(&H256, &mut i64)> = Vec::with_capacity(CHUNK_SIZE);
            for (hash, (block_height, stored_id)) in chunk {
                let block_height = *block_height;

                let info = match self.provider.get_block_by_height(block_height).await {
                    Ok(info) => info,
                    Err(e) => {
                        warn!(block_hash = ?hash, ?block_height, ?e, "error fetching and parsing block");
                        continue;
                    }
                };
                let block_id = stored_id.insert(-1);
                block_infos.push(info);
                blocks_to_insert.push((hash, block_id));
            }

            // If we have no blocks to insert, we don't store them and we don't update
            // database block ids.
            if blocks_to_insert.is_empty() {
                continue;
            }

            self.db
                .store_blocks(self.domain.id(), block_infos.into_iter())
                .await?;

            let hashes = self
                .db
                .get_block_basic(blocks_to_insert.iter().map(|(hash, _)| *hash))
                .await?
                .into_iter()
                .map(|b| (b.hash, b.id))
                .collect::<HashMap<_, _>>();

            for (hash, block_id) in blocks_to_insert {
                if let Some(id) = hashes.get(hash) {
                    *block_id = *id;
                }
            }
        }

        let ensured_blocks = blocks.into_iter().filter_map(|(hash, (_, id))| {
            id.filter(|id| *id != -1).map(|id| BasicBlock { id, hash })
        });

        Ok(ensured_blocks)
    }
}

#[async_trait]
impl<T> HyperlaneWatermarkedLogStore<T> for HyperlaneDbStore
where
    HyperlaneDbStore: HyperlaneLogStore<T>,
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

/// Resolves the database transaction id for a log's meta.
///
/// - `Some(Some(id))` when the transaction was ensured in the database.
/// - `Some(None)` when the meta carries zero transaction and block hashes,
///   meaning the indexer could not resolve the on-chain transaction (e.g. the
///   Sealevel basic log meta fallback); the event must still be persisted with
///   a NULL transaction relation so it remains retrievable by sequence.
/// - `None` when the transaction could not be fetched; the event is skipped
///   and retried later.
pub(crate) fn txn_id_for_meta(txns: &HashMap<H512, i64>, meta: &LogMeta) -> Option<Option<i64>> {
    if meta.transaction_id.is_zero() && meta.block_hash.is_zero() {
        Some(None)
    } else {
        txns.get(&meta.transaction_id).copied().map(Some)
    }
}

#[derive(Debug, Clone)]
struct TxnWithBlockId {
    txn_hash: H512,
    block_id: i64,
}

fn as_chunks<T>(
    mut iter: impl Iterator<Item = T>,
    chunk_size: usize,
) -> impl Iterator<Item = Vec<T>> {
    assert!(chunk_size > 0, "chunk size must be positive");
    // Own just the current chunk across await points. itertools::chunks keeps
    // a RefCell borrowed by each chunk, which cannot be held across awaits.
    std::iter::from_fn(move || {
        let chunk: Vec<_> = iter.by_ref().take(chunk_size).collect();
        (!chunk.is_empty()).then_some(chunk)
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::as_chunks;

    #[test]
    fn enrichment_chunks_only_consume_the_requested_batch() {
        let consumed = Cell::new(0);
        let input = (0..1_000).inspect(|_| consumed.set(consumed.get() + 1));
        let mut chunks = as_chunks(input, 50);
        assert_eq!(consumed.get(), 0);
        assert_eq!(chunks.next(), Some((0..50).collect()));
        assert_eq!(consumed.get(), 50);
        assert_eq!(chunks.next(), Some((50..100).collect()));
        assert_eq!(consumed.get(), 100);
        drop(chunks);
        assert_eq!(
            consumed.get(),
            100,
            "dropping work must not consume later chunks"
        );
    }

    #[test]
    fn enrichment_chunks_preserve_order_and_partial_tail() {
        assert_eq!(
            as_chunks(0..5, 2).collect::<Vec<_>>(),
            vec![vec![0, 1], vec![2, 3], vec![4]]
        );
        assert_eq!(
            as_chunks(0..4, 2).collect::<Vec<_>>(),
            vec![vec![0, 1], vec![2, 3]]
        );
        assert_eq!(as_chunks(0..1, 2).collect::<Vec<_>>(), vec![vec![0]]);
        assert_eq!(as_chunks(0..0, 2).next(), None);
    }

    #[test]
    #[should_panic(expected = "chunk size must be positive")]
    fn enrichment_chunks_reject_zero_chunk_size() {
        let _ = as_chunks(0..1, 0);
    }
}

#[cfg(test)]
mod block_tests;
