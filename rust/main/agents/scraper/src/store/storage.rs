//! Fetch and persist block/transaction metadata shared by receipt enrichment and CCR.

use std::{collections::HashMap, sync::Arc};

use eyre::Result;
use futures::{stream, StreamExt};
use tokio::sync::Semaphore;
use tracing::{trace, warn};

use hyperlane_base::settings::CoreContractAddresses;
use hyperlane_core::{BlockId, HyperlaneDomain, HyperlaneProvider, LogMeta, H256, H512};

use crate::db::{BasicBlock, ScraperDb, StorableTxn};

/// Maximum number of records to query at a time. This came about because when a
/// lot of messages are sent in a short period of time we were ending up with a
/// lot of data to query from the node provider between points when we would
/// actually save it to the database.
const CHUNK_SIZE: usize = 50;

/// Database and provider context for enriching one chain’s events.
#[derive(Clone, Debug)]
pub struct HyperlaneDbStore {
    pub(crate) db: ScraperDb,
    pub(crate) domain: HyperlaneDomain,
    pub(crate) mailbox_address: H256,
    provider: Arc<dyn HyperlaneProvider>,
}

impl HyperlaneDbStore {
    pub fn new(
        db: ScraperDb,
        domain: HyperlaneDomain,
        addresses: CoreContractAddresses,
        provider: Arc<dyn HyperlaneProvider>,
    ) -> Self {
        Self {
            db,
            domain,
            mailbox_address: addresses.mailbox,
            provider,
        }
    }

    /// Enrich a confirmed near-head page whose block headers are already retained.
    /// Look up the page's cache entries together, then persist missing receipts
    /// independently so one failed or timed-out fetch cannot discard successes.
    pub(crate) async fn ensure_transactions_for_known_blocks(
        &self,
        log_meta: impl Iterator<Item = &LogMeta>,
        rpc_permits: &Semaphore,
        domain_rpc_permits: &Semaphore,
        db_permits: &Semaphore,
    ) -> Result<bool> {
        let requested: HashMap<_, _> = log_meta
            .filter(|meta| !meta.transaction_id.is_zero() && !meta.block_hash.is_zero())
            .map(|meta| (meta.transaction_id, meta.block_hash))
            .collect();
        if requested.is_empty() {
            return Ok(true);
        }
        let db_permit = db_permits.acquire().await?;
        let blocks = self.db.get_block_basic(requested.values()).await?;
        let existing = self.db.get_txn_ids(requested.keys()).await?;
        drop(db_permit);
        let blocks: HashMap<_, _> = blocks.into_iter().map(|b| (b.hash, b.id)).collect();
        eyre::ensure!(
            requested.values().all(|hash| blocks.contains_key(hash)),
            "Confirmed receipt page is missing retained block headers"
        );
        let missing = requested
            .into_iter()
            .filter(|(hash, _)| !existing.contains_key(hash));
        let mut results = stream::iter(missing)
            .map(|(hash, block_hash)| {
                let blocks = &blocks;
                async move {
                    let result = async {
                        let block_id = *blocks
                            .get(&block_hash)
                            .ok_or_else(|| eyre::eyre!("Missing retained block"))?;
                        let domain_rpc_permit = domain_rpc_permits.acquire().await?;
                        let rpc_permit = rpc_permits.acquire().await?;
                        let info = self.provider.get_txn_by_hash(&hash).await?;
                        drop(rpc_permit);
                        drop(domain_rpc_permit);
                        let _db_permit = db_permits.acquire().await?;
                        self.db
                            .store_txns(std::iter::once(StorableTxn { info, block_id }))
                            .await?;
                        Ok::<_, eyre::Report>(())
                    }
                    .await;
                    if let Err(error) = &result {
                        warn!(
                            domain = self.domain.id(),
                            ?hash,
                            ?error,
                            "Receipt unavailable; retrying"
                        );
                    }
                    result.is_ok()
                }
            })
            .buffer_unordered(8);
        let mut complete = true;
        while let Some(success) = results.next().await {
            complete &= success;
        }
        Ok(complete)
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
            .filter_map(move |(txn, block)| blocks.get(&block.hash).map(|id| (txn, *id)));
        let txns_with_ids = self.ensure_txns(txn_hash_with_block_ids).await?;

        Ok(txns_with_ids)
    }

    /// Fetch missing transactions in bounded batches. A failed RPC leaves its hash
    /// absent so the caller can retry without discarding successful siblings.
    async fn ensure_txns(
        &self,
        txns: impl Iterator<Item = (H512, i64)>,
    ) -> Result<impl Iterator<Item = (H512, i64)>> {
        let requested: HashMap<_, _> = txns.collect();
        let mut stored = self.db.get_txn_ids(requested.keys()).await?;
        let missing: Vec<_> = requested
            .into_iter()
            .filter(|(hash, _)| !stored.contains_key(hash) && !hash.is_zero())
            .collect();
        for chunk in as_chunks(missing.into_iter(), CHUNK_SIZE) {
            let mut rows = Vec::with_capacity(chunk.len());
            for (hash, block_id) in chunk {
                match self.provider.get_txn_by_hash(&hash).await {
                    Ok(info) if info.hash == hash => rows.push(StorableTxn { info, block_id }),
                    Ok(info) => warn!(requested_hash = ?hash, returned_hash = ?info.hash,
                        "transaction enrichment returned a different hash"),
                    Err(error) => warn!(?hash, ?error, "error fetching and parsing transaction"),
                }
            }
            if rows.is_empty() {
                continue;
            }
            let hashes: Vec<_> = rows.iter().map(|row| row.info.hash).collect();
            let mut inserted = self.db.store_txns(rows.into_iter()).await?;
            // RETURNING omits concurrent winners. A fresh statement sees their commits.
            let existing = self
                .db
                .get_txn_ids(hashes.iter().filter(|hash| !inserted.contains_key(*hash)))
                .await?;
            inserted.extend(existing);
            stored.extend(inserted);
        }
        Ok(stored.into_iter())
    }

    /// Resolve known headers, then fetch missing ones without accepting a different fork.
    async fn ensure_blocks(
        &self,
        block_ids: impl Iterator<Item = BlockId>,
    ) -> Result<impl Iterator<Item = BasicBlock>> {
        // Duplicate hashes retain the last requested height.
        let requested: HashMap<_, _> = block_ids.map(|block| (block.hash, block.height)).collect();
        let mut stored: HashMap<_, _> = self
            .db
            .get_block_basic(requested.keys())
            .await?
            .into_iter()
            .map(|block| (block.hash, block.id))
            .collect();
        let missing: Vec<_> = requested
            .into_iter()
            .filter(|(hash, _)| !stored.contains_key(hash))
            .collect();
        for chunk in as_chunks(missing.into_iter(), CHUNK_SIZE) {
            let mut rows = Vec::with_capacity(chunk.len());
            for (hash, height) in chunk {
                match self.provider.get_block_by_height(height).await {
                    Ok(info) if info.hash == hash && info.number == height => rows.push(info),
                    Ok(info) => {
                        warn!(requested_hash = ?hash, requested_height = height, returned_block = ?info,
                        "block enrichment returned a different block")
                    }
                    Err(error) => warn!(block_hash = ?hash, block_height = height, ?error,
                        "error fetching and parsing block"),
                }
            }
            if rows.is_empty() {
                continue;
            }
            let hashes: Vec<_> = rows.iter().map(|row| row.hash).collect();
            let mut inserted: HashMap<_, _> = self
                .db
                .store_blocks(self.domain.id(), rows.into_iter())
                .await?
                .into_iter()
                .map(|block| (block.hash, block.id))
                .collect();
            let existing = self
                .db
                .get_block_basic(hashes.iter().filter(|hash| !inserted.contains_key(*hash)))
                .await?;
            inserted.extend(existing.into_iter().map(|block| (block.hash, block.id)));
            stored.extend(inserted);
        }
        Ok(stored.into_iter().map(|(hash, id)| BasicBlock { id, hash }))
    }
}

/// Reject incomplete CCR batches before assigning synthetic nonces.
pub(crate) fn ensure_event_enrichment_complete<'a>(
    txns: &HashMap<H512, i64>,
    log_meta: impl Iterator<Item = &'a LogMeta>,
) -> Result<()> {
    for meta in log_meta {
        eyre::ensure!(
            meta.transaction_id.is_zero() || txns.contains_key(&meta.transaction_id),
            "Incomplete event enrichment at block {} ({:?}), transaction {:?}; retrying range",
            meta.block_number,
            meta.block_hash,
            meta.transaction_id,
        );
    }
    Ok(())
}

/// Resolves the database transaction id for a log's meta.
///
/// - `Some(Some(id))` when the transaction was ensured in the database.
/// - `Some(None)` when the meta carries zero transaction and block hashes,
///   meaning the indexer could not resolve the on-chain transaction (e.g. the
///   Sealevel basic log meta fallback); the event must still be persisted with
///   a NULL transaction relation so it remains retrievable by sequence.
/// - `None` when enrichment is incomplete. Only callers with a durable raw
///   event for reconciliation may skip a required nonzero transaction; other
///   callers must return an error. Zero-tx Cosmos block events remain unsupported.
pub(crate) fn txn_id_for_meta(txns: &HashMap<H512, i64>, meta: &LogMeta) -> Option<Option<i64>> {
    if meta.transaction_id.is_zero() && meta.block_hash.is_zero() {
        Some(None)
    } else {
        txns.get(&meta.transaction_id).copied().map(Some)
    }
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

#[cfg(test)]
mod returning_tests;

#[cfg(test)]
mod event_loss_tests;
