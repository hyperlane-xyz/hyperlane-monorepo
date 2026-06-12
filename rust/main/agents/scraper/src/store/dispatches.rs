use std::collections::HashMap;

use async_trait::async_trait;
use eyre::{Report, Result};
use hyperlane_core::{
    unwrap_or_none_result, HyperlaneLogStore, HyperlaneMessage,
    HyperlaneSequenceAwareIndexerStoreReader, Indexed, LogMeta, H512,
};
use tracing::warn;

use crate::db::{StorableMessage, StorableRawMessageDispatch};
use crate::store::storage::{HyperlaneDbStore, TxnWithId};

/// Label for raw message dispatch metrics
const RAW_MESSAGE_DISPATCH_LABEL: &str = "raw_message_dispatch";

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
        self.store_raw_message_dispatches(messages).await;

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
    ) {
        let raw_messages = messages
            .iter()
            .map(|(message, meta)| StorableRawMessageDispatch {
                msg: message.inner(),
                meta,
            });
        let raw_stored = self
            .db
            .store_raw_message_dispatches(self.domain.id(), &self.mailbox_address, raw_messages)
            .await
            .unwrap_or_else(|e| {
                warn!(
                    ?e,
                    "Failed to store raw message dispatches, continuing with enriched storage"
                );
                0
            });

        // Track raw message dispatches in metrics for E2E verification
        if let Some(metric) = self.stored_events_metric() {
            metric
                .with_label_values(&[RAW_MESSAGE_DISPATCH_LABEL, self.domain.name()])
                .inc_by(raw_stored);
        }
    }

    async fn store_enriched_message_dispatches(
        &self,
        messages: &[(Indexed<HyperlaneMessage>, LogMeta)],
    ) -> Result<u32, Report> {
        let txns: HashMap<H512, TxnWithId> = self
            .ensure_blocks_and_txns(messages.iter().map(|r| &r.1))
            .await?
            .map(|t| (t.hash, t))
            .collect();
        let storable = storable_messages_for_txns(messages, &txns)?;
        let stored = self
            .db
            .store_dispatched_messages(
                self.domain.id(),
                &self.mailbox_address,
                storable.into_iter(),
            )
            .await?;
        Ok(stored as u32)
    }
}

fn storable_messages_for_txns<'a>(
    messages: &'a [(Indexed<HyperlaneMessage>, LogMeta)],
    txns: &HashMap<H512, TxnWithId>,
) -> Result<Vec<StorableMessage<'a>>, Report> {
    let mut missing_dispatch_tx_hashes = Vec::new();
    let mut missing_tx_hashes = Vec::new();
    let mut storable = Vec::with_capacity(messages.len());

    for (message, meta) in messages {
        let Some(txn) = txns.get(&meta.transaction_id) else {
            missing_dispatch_tx_hashes.push(meta.transaction_id);
            if !missing_tx_hashes.contains(&meta.transaction_id) {
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

    if !missing_tx_hashes.is_empty() {
        let missing_dispatches = missing_dispatch_tx_hashes.len();
        eyre::bail!(
            "failed to enrich {missing_dispatches} of {} message dispatches; missing transaction ids: {missing_tx_hashes:?}",
            messages.len(),
        );
    }

    Ok(storable)
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
    fn storable_messages_for_txns_allows_multiple_messages_per_txn() {
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

        let storable = storable_messages_for_txns(&messages, &txns)
            .expect("all messages should have transaction ids");

        assert_eq!(storable.len(), messages.len());
        assert!(storable.iter().all(|message| message.txn_id == 7));
    }

    #[test]
    fn storable_messages_for_txns_errors_on_missing_enrichment_txn() {
        let found_txn_hash = H512::from_low_u64_be(1);
        let missing_txn_hash = H512::from_low_u64_be(2);
        let messages = vec![
            (indexed_message(0), log_meta(found_txn_hash)),
            (indexed_message(1), log_meta(missing_txn_hash)),
            (indexed_message(2), log_meta(missing_txn_hash)),
        ];
        let txns = HashMap::from([(
            found_txn_hash,
            TxnWithId {
                hash: found_txn_hash,
                id: 7,
            },
        )]);

        let err = storable_messages_for_txns(&messages, &txns)
            .err()
            .expect("expected missing transaction id error");

        assert!(err.to_string().contains("failed to enrich 2 of 3"));
        assert!(err.to_string().contains(&format!("{missing_txn_hash:?}")));
    }
}
