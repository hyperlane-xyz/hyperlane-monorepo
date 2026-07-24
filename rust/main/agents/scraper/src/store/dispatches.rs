use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::{
    unwrap_or_none_result, HyperlaneLogStore, HyperlaneMessage,
    HyperlaneSequenceAwareIndexerStoreReader, Indexed, LogMeta, H512,
};
use time::OffsetDateTime;
use tracing::warn;

use crate::db::{StorableMessage, StorableRawMessageDispatch};
use crate::store::storage::{HyperlaneDbStore, TxnWithId};

/// Label for raw message dispatch metrics
const RAW_MESSAGE_DISPATCH_LABEL: &str = "raw_message_dispatch";
const RAW_DISPATCH_RETRY_INITIAL_BACKOFF_SECONDS: i64 = 60;
const RAW_DISPATCH_RETRY_MAX_BACKOFF_SECONDS: i64 = 15 * 60;

#[derive(Debug, Default)]
pub(crate) struct RawDispatchReconciliationResult {
    pub candidate_count: usize,
    pub attempted_count: usize,
    pub skipped_backoff_count: usize,
    pub stored_count: u32,
    pub next_after_id: i64,
    pub max_unenriched_age_seconds: u64,
}

#[derive(Debug, Default)]
pub(crate) struct RawDispatchRetryBackoff {
    rows: HashMap<i64, RawDispatchRetry>,
}

#[derive(Debug)]
struct RawDispatchRetry {
    attempts: u32,
    next_retry_at: OffsetDateTime,
}

impl RawDispatchRetryBackoff {
    fn should_attempt(&self, raw_id: i64, now: OffsetDateTime) -> bool {
        match self.rows.get(&raw_id) {
            Some(retry) => retry.next_retry_at <= now,
            None => true,
        }
    }

    fn record_missing(&mut self, raw_id: i64, now: OffsetDateTime) -> u32 {
        let retry = self.rows.entry(raw_id).or_insert(RawDispatchRetry {
            attempts: 0,
            next_retry_at: now,
        });
        retry.attempts = retry.attempts.saturating_add(1);

        let multiplier = 2_i64.pow(retry.attempts.saturating_sub(1).min(4));
        let backoff_seconds = RAW_DISPATCH_RETRY_INITIAL_BACKOFF_SECONDS
            .saturating_mul(multiplier)
            .min(RAW_DISPATCH_RETRY_MAX_BACKOFF_SECONDS);
        retry.next_retry_at = offset_by_seconds(now, backoff_seconds);
        retry.attempts
    }

    fn record_success(&mut self, raw_id: i64) {
        self.rows.remove(&raw_id);
    }
}

#[async_trait]
impl HyperlaneLogStore<HyperlaneMessage> for HyperlaneDbStore {
    /// Store dispatched messages from the origin mailbox into the database.
    /// We store raw messages first (no RPC dependencies), then full messages.
    /// Raw messages enable CCTP to query transaction hashes even during RPC failures.
    async fn store_logs(&self, messages: &[(Indexed<HyperlaneMessage>, LogMeta)]) -> Result<u32> {
        if messages.is_empty() {
            return Ok(0);
        }

        // STEP 1: Store a raw message dispatches FIRST (zero RPC dependencies)
        // This ensures Offchain Lookup Server can query transaction hashes even if RPC providers fail
        self.store_raw_message_dispatches(messages).await?;

        // STEP 2: Store full messages (requires RPC calls for block/transaction data)
        // If RPC fails here, raw messages are already stored and Offchain Lookup Server can still
        // function
        self.store_enriched_message_dispatches(messages).await
    }
}

impl HyperlaneDbStore {
    async fn store_raw_message_dispatches(
        &self,
        messages: &[(Indexed<HyperlaneMessage>, LogMeta)],
    ) -> Result<()> {
        let raw_messages = messages
            .iter()
            .map(|(message, meta)| StorableRawMessageDispatch {
                msg: message.inner(),
                meta,
            });
        let raw_stored = self
            .db
            .store_raw_message_dispatches(self.domain.id(), &self.mailbox_address, raw_messages)
            .await?;

        // Track raw message dispatches in metrics for E2E verification
        if let Some(metric) = self.stored_events_metric() {
            metric
                .with_label_values(&[RAW_MESSAGE_DISPATCH_LABEL, self.domain.name()])
                .inc_by(raw_stored);
        }
        Ok(())
    }

    pub(crate) async fn store_enriched_message_dispatches(
        &self,
        messages: &[(Indexed<HyperlaneMessage>, LogMeta)],
    ) -> Result<u32> {
        let txns: HashMap<H512, TxnWithId> = self
            .ensure_blocks_and_txns(messages.iter().map(|r| &r.1))
            .await?
            .map(|t| (t.hash, t))
            .collect();
        let (storable, missing_txns) = storable_messages_for_available_txns(messages, &txns);
        let stored = self
            .db
            .store_dispatched_messages(
                self.domain.id(),
                &self.mailbox_address,
                storable.into_iter(),
            )
            .await?;

        if let Some(missing_txns) = missing_txns {
            warn!(
                stored,
                missing_dispatches = missing_txns.missing_dispatches,
                total_dispatches = messages.len(),
                missing_tx_hashes = ?missing_txns.missing_tx_hashes,
                "Stored available enriched message dispatches; raw rows remain pending for reconciliation"
            );
        }

        Ok(stored as u32)
    }

    pub(crate) async fn reconcile_raw_message_dispatches(
        &self,
        after_id: i64,
        limit: u64,
        retry_backoff: &mut RawDispatchRetryBackoff,
    ) -> Result<RawDispatchReconciliationResult> {
        let raw_dispatches = self
            .db
            .retrieve_unenriched_raw_dispatches(
                self.domain.id(),
                &self.mailbox_address,
                after_id,
                limit,
            )
            .await?;
        let now = OffsetDateTime::now_utc();
        let max_unenriched_age_seconds = raw_dispatches
            .iter()
            .map(|raw_dispatch| raw_dispatch_age_seconds(raw_dispatch.time_created, now))
            .max()
            .unwrap_or_default();
        if raw_dispatches.is_empty() {
            return Ok(RawDispatchReconciliationResult {
                next_after_id: after_id,
                max_unenriched_age_seconds,
                ..Default::default()
            });
        }
        let next_after_id = raw_dispatches
            .iter()
            .map(|raw_dispatch| raw_dispatch.raw_id)
            .max()
            .unwrap_or(after_id);
        let skipped_backoff_count = raw_dispatches
            .iter()
            .filter(|raw_dispatch| !retry_backoff.should_attempt(raw_dispatch.raw_id, now))
            .count();
        let raw_dispatches_to_attempt = raw_dispatches
            .iter()
            .filter(|raw_dispatch| retry_backoff.should_attempt(raw_dispatch.raw_id, now))
            .collect::<Vec<_>>();

        if raw_dispatches_to_attempt.is_empty() {
            return Ok(RawDispatchReconciliationResult {
                candidate_count: raw_dispatches.len(),
                skipped_backoff_count,
                next_after_id,
                max_unenriched_age_seconds,
                ..Default::default()
            });
        }

        let txns: HashMap<H512, TxnWithId> = self
            .ensure_blocks_and_txns(raw_dispatches_to_attempt.iter().map(|r| &r.meta))
            .await?
            .map(|t| (t.hash, t))
            .collect();

        let mut missing_tx_hashes = Vec::new();
        let mut unique_missing_tx_hashes = HashSet::new();
        let mut stored_raw_ids = Vec::new();
        let storable = raw_dispatches_to_attempt
            .iter()
            .filter_map(
                |raw_dispatch| match txns.get(&raw_dispatch.meta.transaction_id) {
                    Some(txn) => {
                        stored_raw_ids.push(raw_dispatch.raw_id);
                        Some(raw_dispatch.storable_message(txn.id))
                    }
                    None => {
                        let attempts = retry_backoff.record_missing(raw_dispatch.raw_id, now);
                        if unique_missing_tx_hashes.insert(raw_dispatch.meta.transaction_id) {
                            missing_tx_hashes.push(raw_dispatch.meta.transaction_id);
                        }
                        warn!(
                            raw_id = raw_dispatch.raw_id,
                            attempts,
                            "Raw message dispatch transaction remains unavailable; backing off reconciliation"
                        );
                        None
                    }
                },
            )
            .collect::<Vec<_>>();

        let stored = self
            .db
            .store_dispatched_messages(
                self.domain.id(),
                &self.mailbox_address,
                storable.into_iter(),
            )
            .await?;
        for raw_id in stored_raw_ids {
            retry_backoff.record_success(raw_id);
        }

        if !missing_tx_hashes.is_empty() {
            warn!(
                candidate_count = raw_dispatches.len(),
                attempted = raw_dispatches_to_attempt.len(),
                skipped_backoff = skipped_backoff_count,
                stored,
                missing_tx_hashes = ?missing_tx_hashes,
                "Raw message dispatch reconciliation skipped rows whose transactions are not enriched yet"
            );
        }

        Ok(RawDispatchReconciliationResult {
            candidate_count: raw_dispatches.len(),
            attempted_count: raw_dispatches_to_attempt.len(),
            skipped_backoff_count,
            stored_count: stored as u32,
            next_after_id,
            max_unenriched_age_seconds,
        })
    }
}

fn raw_dispatch_age_seconds(
    time_created: sea_orm::prelude::TimeDateTime,
    now: OffsetDateTime,
) -> u64 {
    now.unix_timestamp()
        .saturating_sub(time_created.assume_utc().unix_timestamp())
        .max(0) as u64
}

fn offset_by_seconds(now: OffsetDateTime, seconds: i64) -> OffsetDateTime {
    now.checked_add(time::Duration::seconds(seconds))
        .unwrap_or(now)
}

#[derive(Debug, PartialEq, Eq)]
struct MissingDispatchTxns {
    missing_dispatches: usize,
    missing_tx_hashes: Vec<H512>,
}

fn storable_messages_for_available_txns<'a>(
    messages: &'a [(Indexed<HyperlaneMessage>, LogMeta)],
    txns: &HashMap<H512, TxnWithId>,
) -> (Vec<StorableMessage<'a>>, Option<MissingDispatchTxns>) {
    let mut missing_dispatches: usize = 0;
    let mut missing_tx_hashes = Vec::new();
    let mut unique_missing_tx_hashes = HashSet::new();
    let mut storable = Vec::with_capacity(messages.len());

    for (message, meta) in messages {
        let Some(txn) = txns.get(&meta.transaction_id) else {
            missing_dispatches = missing_dispatches.saturating_add(1);
            if unique_missing_tx_hashes.insert(meta.transaction_id) {
                missing_tx_hashes.push(meta.transaction_id);
            }
            continue;
        };

        storable.push(StorableMessage {
            msg: message.inner().clone(),
            meta,
            txn_id: txn.id,
            id_override: None,
        });
    }

    let missing_txns = (missing_dispatches > 0).then_some(MissingDispatchTxns {
        missing_dispatches,
        missing_tx_hashes,
    });
    (storable, missing_txns)
}

#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<HyperlaneMessage> for HyperlaneDbStore {
    /// Gets a message by its nonce.
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<HyperlaneMessage>> {
        let message = self
            .db
            .retrieve_dispatched_message_by_nonce(self.domain.id(), &self.mailbox_address, sequence)
            .await?;
        Ok(message)
    }

    /// Gets the block number at which the log occurred.
    async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> Result<Option<u64>> {
        let tx_id = unwrap_or_none_result!(
            self.db
                .retrieve_dispatched_tx_id(self.domain.id(), &self.mailbox_address, sequence)
                .await?
        );
        let block_id = unwrap_or_none_result!(self.db.retrieve_block_id(tx_id).await?);
        Ok(self.db.retrieve_block_number(block_id).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn indexed_message(nonce: u32) -> Indexed<HyperlaneMessage> {
        Indexed::new(HyperlaneMessage {
            nonce,
            ..Default::default()
        })
    }

    fn log_meta(transaction_id: H512) -> LogMeta {
        LogMeta {
            transaction_id,
            ..Default::default()
        }
    }

    #[test]
    fn storable_messages_for_available_txns_allows_multiple_messages_per_txn() {
        let txn_hash = H512::from_low_u64_be(1);
        let messages = vec![
            (indexed_message(0), log_meta(txn_hash)),
            (indexed_message(1), log_meta(txn_hash)),
        ];
        let txns = HashMap::from([(
            txn_hash,
            TxnWithId {
                hash: txn_hash,
                id: 7,
            },
        )]);

        let (storable, missing_txns) = storable_messages_for_available_txns(&messages, &txns);

        assert!(missing_txns.is_none());
        assert_eq!(storable.len(), messages.len());
        assert!(storable.iter().all(|message| message.txn_id == 7));
    }

    #[test]
    fn storable_messages_for_available_txns_stores_later_rows_after_missing_txn() {
        let found_txn_hash = H512::from_low_u64_be(1);
        let missing_txn_hash = H512::from_low_u64_be(2);
        let later_found_txn_hash = H512::from_low_u64_be(3);
        let messages = vec![
            (indexed_message(0), log_meta(found_txn_hash)),
            (indexed_message(1), log_meta(missing_txn_hash)),
            (indexed_message(2), log_meta(later_found_txn_hash)),
        ];
        let txns = HashMap::from([
            (
                found_txn_hash,
                TxnWithId {
                    hash: found_txn_hash,
                    id: 7,
                },
            ),
            (
                later_found_txn_hash,
                TxnWithId {
                    hash: later_found_txn_hash,
                    id: 8,
                },
            ),
        ]);

        let (storable, missing_txns) = storable_messages_for_available_txns(&messages, &txns);

        assert_eq!(storable.len(), 2);
        assert_eq!(storable[0].msg.nonce, 0);
        assert_eq!(storable[0].txn_id, 7);
        assert_eq!(storable[1].msg.nonce, 2);
        assert_eq!(storable[1].txn_id, 8);
        assert_eq!(
            missing_txns,
            Some(MissingDispatchTxns {
                missing_dispatches: 1,
                missing_tx_hashes: vec![missing_txn_hash],
            })
        );
    }

    #[test]
    fn storable_messages_for_available_txns_all_missing_returns_empty() {
        let missing_txn_hash = H512::from_low_u64_be(2);
        let messages = vec![
            (indexed_message(0), log_meta(missing_txn_hash)),
            (indexed_message(1), log_meta(missing_txn_hash)),
        ];
        let txns = HashMap::new();

        let (storable, missing_txns) = storable_messages_for_available_txns(&messages, &txns);

        assert!(storable.is_empty());
        assert_eq!(
            missing_txns,
            Some(MissingDispatchTxns {
                missing_dispatches: 2,
                missing_tx_hashes: vec![missing_txn_hash],
            })
        );
    }

    #[test]
    fn storable_messages_for_available_txns_empty_input_returns_empty() {
        let messages = vec![];
        let txns = HashMap::new();

        let (storable, missing_txns) = storable_messages_for_available_txns(&messages, &txns);

        assert!(storable.is_empty());
        assert!(missing_txns.is_none());
    }

    #[test]
    fn raw_dispatch_retry_backoff_delays_repeated_attempts() {
        let now = OffsetDateTime::now_utc();
        let raw_id = 7;
        let mut backoff = RawDispatchRetryBackoff::default();

        assert!(backoff.should_attempt(raw_id, now));
        assert_eq!(backoff.record_missing(raw_id, now), 1);
        assert!(!backoff.should_attempt(raw_id, now));
        assert!(!backoff.should_attempt(
            raw_id,
            offset_by_seconds(
                now,
                RAW_DISPATCH_RETRY_INITIAL_BACKOFF_SECONDS.saturating_sub(1)
            )
        ));
        assert!(backoff.should_attempt(
            raw_id,
            offset_by_seconds(now, RAW_DISPATCH_RETRY_INITIAL_BACKOFF_SECONDS)
        ));
    }

    #[test]
    fn raw_dispatch_retry_backoff_clears_after_success() {
        let now = OffsetDateTime::now_utc();
        let raw_id = 7;
        let mut backoff = RawDispatchRetryBackoff::default();

        backoff.record_missing(raw_id, now);
        assert!(!backoff.should_attempt(raw_id, now));

        backoff.record_success(raw_id);
        assert!(backoff.should_attempt(raw_id, now));
    }
}
