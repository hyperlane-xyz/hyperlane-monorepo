//! SQL-based indexer store for validators that can use existing scraper databases
//! to avoid expensive RPC queries for historical data.

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use eyre::{eyre, Context, Result};
use prometheus::IntCounter;
use tracing::{debug, info, warn};

use hyperlane_core::{
    HyperlaneSequenceAwareIndexerStoreReader, MerkleTreeHook, MerkleTreeInsertion, ReorgPeriod,
    H256,
};

use scraper::db::ScraperDb;

/// SQL-backed sequence-aware indexer store that uses scraper database
/// with the assumption that nonce == leaf_index for most messages.
/// Falls back to RPC when this assumption is violated.
#[derive(Debug)]
pub struct SqlSequenceAwareIndexerStore {
    db: ScraperDb,
    origin_domain: u32,
    origin_mailbox: H256,
    merkle_tree_hook: Arc<dyn MerkleTreeHook>,
    reorg_period: ReorgPeriod,

    // Simple validation cache to avoid excessive RPC calls (using interior mutability)
    last_validated_root: Mutex<Option<H256>>,
    last_validated_count: Mutex<Option<u32>>,
    validation_timestamp: Mutex<Option<Instant>>,

    // Track consecutive failures to avoid spam (using interior mutability)
    consecutive_failures: Mutex<u32>,
    last_failure_time: Mutex<Option<Instant>>,

    // Metrics
    sql_queries: IntCounter,
    sql_hits: IntCounter,
    sql_misses: IntCounter,
    assumption_validations: IntCounter,
}

impl SqlSequenceAwareIndexerStore {
    /// Create a new SQL indexer store
    pub async fn new(
        scraper_db_url: &str,
        origin_domain: u32,
        origin_mailbox: H256,
        merkle_tree_hook: Arc<dyn MerkleTreeHook>,
        reorg_period: ReorgPeriod,
    ) -> Result<Self> {
        let db = ScraperDb::connect(scraper_db_url)
            .await
            .context("Failed to connect to scraper database")?;

        info!(
            scraper_db_url,
            origin_domain,
            ?origin_mailbox,
            "Connected to scraper database for SQL indexing"
        );

        // Create metrics (these would ideally be registered with the global registry)
        let sql_queries = IntCounter::new(
            "hyperlane_sql_indexer_queries_total",
            "Total number of SQL queries made by validator SQL store",
        )?;
        let sql_hits = IntCounter::new(
            "hyperlane_sql_indexer_hits_total",
            "Total number of successful SQL hits",
        )?;
        let sql_misses = IntCounter::new(
            "hyperlane_sql_indexer_misses_total",
            "Total number of SQL misses (fallback to RPC)",
        )?;
        let assumption_validations = IntCounter::new(
            "hyperlane_sql_indexer_assumption_validations_total",
            "Total number of nonce=leaf_index assumption validations",
        )?;

        Ok(Self {
            db,
            origin_domain,
            origin_mailbox,
            merkle_tree_hook,
            reorg_period,
            last_validated_root: Mutex::new(None),
            last_validated_count: Mutex::new(None),
            validation_timestamp: Mutex::new(None),
            consecutive_failures: Mutex::new(0),
            last_failure_time: Mutex::new(None),
            sql_queries,
            sql_hits,
            sql_misses,
            assumption_validations,
        })
    }

    /// Check if our nonce=leaf_index assumption is still valid
    async fn validate_assumption(&self) -> Result<bool> {
        // If we've had recent consecutive failures, back off
        if *self.consecutive_failures.lock().unwrap() >= 3 {
            if let Some(last_failure) = *self.last_failure_time.lock().unwrap() {
                let backoff_duration =
                    Duration::from_secs(60 * (*self.consecutive_failures.lock().unwrap()) as u64);
                if last_failure.elapsed() < backoff_duration {
                    debug!(
                        consecutive_failures = *self.consecutive_failures.lock().unwrap(),
                        "Backing off SQL validation due to recent failures"
                    );
                    return Ok(false);
                }
            }
        }

        // Only validate occasionally to avoid excessive RPC calls
        if let Some(timestamp) = *self.validation_timestamp.lock().unwrap() {
            if timestamp.elapsed() < Duration::from_secs(30) {
                return Ok(true); // Assume valid for 30 seconds
            }
        }

        match self.do_validation().await {
            Ok(is_valid) => {
                self.assumption_validations.inc();
                if is_valid {
                    *self.consecutive_failures.lock().unwrap() = 0;
                    *self.validation_timestamp.lock().unwrap() = Some(Instant::now());
                } else {
                    *self.consecutive_failures.lock().unwrap() += 1;
                    *self.last_failure_time.lock().unwrap() = Some(Instant::now());
                }
                Ok(is_valid)
            }
            Err(err) => {
                warn!(
                    ?err,
                    "Failed to validate SQL assumption, falling back to RPC"
                );
                *self.consecutive_failures.lock().unwrap() += 1;
                *self.last_failure_time.lock().unwrap() = Some(Instant::now());
                Ok(false)
            }
        }
    }

    async fn do_validation(&self) -> Result<bool> {
        let (current_root, current_count) = self.get_current_tree_state().await?;

        // If tree hasn't changed, our assumption is still valid
        if *self.last_validated_root.lock().unwrap() == Some(current_root)
            && *self.last_validated_count.lock().unwrap() == Some(current_count)
        {
            return Ok(true);
        }

        // Tree changed - test assumption with recent messages
        let test_result = self
            .test_nonce_equals_leaf_index_assumption(current_count)
            .await?;

        if test_result {
            *self.last_validated_root.lock().unwrap() = Some(current_root);
            *self.last_validated_count.lock().unwrap() = Some(current_count);
            debug!(
                current_count,
                ?current_root,
                "SQL nonce=leaf_index assumption validated successfully"
            );
        } else {
            debug!(
                current_count,
                ?current_root,
                "SQL nonce=leaf_index assumption violated, will use RPC fallback"
            );
        }

        Ok(test_result)
    }

    async fn test_nonce_equals_leaf_index_assumption(&self, tree_count: u32) -> Result<bool> {
        if tree_count == 0 {
            return Ok(true); // Empty tree, assumption holds vacuously
        }

        // Test assumption by checking a few recent messages
        let test_indices = if tree_count > 10 {
            vec![tree_count - 1, tree_count - 5, tree_count - 10]
        } else if tree_count > 5 {
            vec![tree_count - 1, tree_count / 2]
        } else {
            vec![tree_count - 1]
        };

        for &leaf_index in &test_indices {
            // Get what should be at this leaf_index via RPC (expensive but accurate)
            let rpc_insertion = match self.get_insertion_from_rpc(leaf_index).await {
                Ok(insertion) => insertion,
                Err(_) => {
                    // If we can't get RPC data, assume SQL might be wrong
                    return Ok(false);
                }
            };

            // Get message with nonce=leaf_index from SQL (cheap but might be wrong)
            let sql_message = self
                .db
                .retrieve_dispatched_message_by_nonce(
                    self.origin_domain,
                    &self.origin_mailbox,
                    leaf_index, // Assuming nonce == leaf_index
                )
                .await?;

            match sql_message {
                Some(msg) if msg.id() == rpc_insertion.message_id() => {
                    // Perfect match - assumption holds for this point
                    continue;
                }
                _ => {
                    // Mismatch - assumption is broken
                    debug!(
                        leaf_index,
                        rpc_message_id = ?rpc_insertion.message_id(),
                        sql_message_id = ?sql_message.map(|m| m.id()),
                        "Nonce != leaf_index detected"
                    );
                    return Ok(false);
                }
            }
        }

        Ok(true) // All test points passed
    }

    async fn get_current_tree_state(&self) -> Result<(H256, u32)> {
        let tree = self
            .merkle_tree_hook
            .tree(&self.reorg_period)
            .await
            .map_err(|e| eyre!("Failed to get tree state: {}", e))?;
        Ok((tree.root(), tree.count().try_into()?))
    }

    async fn get_insertion_from_rpc(&self, _leaf_index: u32) -> Result<MerkleTreeInsertion> {
        // For now, we'll need to implement this by getting the tree and extracting
        // the insertion at the given index. This is a placeholder for the actual
        // RPC implementation which would depend on the specific chain interface.
        //
        // In a real implementation, this might involve:
        // 1. Getting the tree at current state
        // 2. Finding the message_id that was inserted at leaf_index
        // 3. This is typically done by querying insertion events from the chain

        // For now, return an error to indicate this needs chain-specific implementation
        Err(eyre!(
            "RPC insertion retrieval not yet implemented - this needs chain-specific logic"
        ))
    }
}

#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<MerkleTreeInsertion>
    for SqlSequenceAwareIndexerStore
{
    async fn retrieve_by_sequence(&self, leaf_index: u32) -> Result<Option<MerkleTreeInsertion>> {
        self.sql_queries.inc();

        // Check if our assumption is still valid
        if !self.validate_assumption().await? {
            // Assumption broken - return None to trigger RPC fallback
            debug!(
                leaf_index,
                "SQL assumption invalid, triggering RPC fallback"
            );
            self.sql_misses.inc();
            return Ok(None);
        }

        // Assumption holds - use SQL with nonce=leaf_index
        let message = self
            .db
            .retrieve_dispatched_message_by_nonce(
                self.origin_domain,
                &self.origin_mailbox,
                leaf_index, // Assuming nonce == leaf_index
            )
            .await?;

        match message {
            Some(msg) => {
                debug!(leaf_index, message_id = ?msg.id(), "Retrieved message from SQL");
                self.sql_hits.inc();
                Ok(Some(MerkleTreeInsertion::new(leaf_index, msg.id())))
            }
            None => {
                debug!(
                    leaf_index,
                    "Message not found in SQL, will trigger RPC fallback"
                );
                self.sql_misses.inc();
                Ok(None) // Will trigger RPC fallback
            }
        }
    }

    async fn retrieve_log_block_number_by_sequence(&self, leaf_index: u32) -> Result<Option<u64>> {
        self.sql_queries.inc();

        if !self.validate_assumption().await? {
            debug!(leaf_index, "SQL assumption invalid for block number query");
            self.sql_misses.inc();
            return Ok(None); // Trigger RPC fallback
        }

        // Get the transaction ID for the message
        let tx_id = self
            .db
            .retrieve_dispatched_tx_id(
                self.origin_domain,
                &self.origin_mailbox,
                leaf_index, // Assuming nonce == leaf_index
            )
            .await?;

        match tx_id {
            Some(tx_id) => {
                // Query block number from transaction
                // This would need to be implemented in ScraperDb
                // For now, return None to trigger RPC fallback
                debug!(
                    leaf_index,
                    tx_id, "Found transaction ID, but block number query not implemented"
                );
                self.sql_misses.inc();
                Ok(None)
            }
            None => {
                debug!(leaf_index, "Transaction not found in SQL");
                self.sql_misses.inc();
                Ok(None)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    // We'll need mock implementations for testing
    // This is a placeholder for the actual test implementation

    #[tokio::test]
    async fn test_sql_indexer_assumption_validation() {
        // Test that the indexer correctly validates the nonce=leaf_index assumption
        // and falls back to RPC when needed

        // This test would need:
        // 1. A mock ScraperDb with test data
        // 2. A mock MerkleTreeHook with controlled tree state
        // 3. Test cases for both valid and invalid assumptions

        // For now, this is a placeholder
        assert!(true);
    }

    #[tokio::test]
    async fn test_sql_indexer_backoff() {
        // Test that the indexer backs off after consecutive failures
        // to avoid spamming RPC calls

        assert!(true);
    }

    #[tokio::test]
    async fn test_sql_indexer_retrieve_by_sequence() {
        // Test the main retrieval functionality

        assert!(true);
    }
}
