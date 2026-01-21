use std::collections::HashMap;

use async_trait::async_trait;
use eyre::Result;
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

        // STEP 2: Store full messages (requires RPC calls for block/transaction data)
        // If RPC fails here, raw messages are already stored and Offchain Lookup Server can still
        // function
        let txns: HashMap<H512, TxnWithId> = self
            .ensure_blocks_and_txns(messages.iter().map(|r| &r.1))
            .await?
            .map(|t| (t.hash, t))
            .collect();
        let storable = messages
            .iter()
            .filter_map(|(message, meta)| {
                txns.get(&meta.transaction_id)
                    .map(|t| (message.inner().clone(), meta, t.id))
            })
            .map(|(msg, meta, txn_id)| StorableMessage { msg, meta, txn_id });
        let stored = self
            .db
            .store_dispatched_messages(self.domain.id(), &self.mailbox_address, storable)
            .await?;
        Ok(stored as u32)
    }
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
