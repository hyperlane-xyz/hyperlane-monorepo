use hyperlane_core::{ChainResult, HyperlaneMessage, Indexer, H512};
use hyperlane_cosmos::cw::CwMailboxDispatchIndexer;
use std::sync::Arc;

use super::extractor::MailboxIndexer;

/// CosmWasm-specific implementation of MailboxIndexer
/// Wraps the existing CwMailboxDispatchIndexer to reuse all existing logic
pub struct CosmosMailboxIndexer {
    indexer: Arc<CwMailboxDispatchIndexer>,
    domain: u32,
}

impl CosmosMailboxIndexer {
    pub fn new(indexer: Arc<CwMailboxDispatchIndexer>, domain: u32) -> Self {
        Self { indexer, domain }
    }
}

#[async_trait::async_trait]
impl MailboxIndexer for CosmosMailboxIndexer {
    async fn fetch_logs_by_tx_hash(&self, tx_hash: &str) -> ChainResult<Vec<HyperlaneMessage>> {
        // Parse tx hash to H512
        // Cosmos tx hashes are typically 64-character hex strings (32 bytes)
        // Need to pad to 64 bytes for H512
        let tx_hash_clean = tx_hash.trim_start_matches("0x");

        // Try parsing as hex (most common format)
        let hash_bytes = hex::decode(tx_hash_clean).map_err(|e| {
            hyperlane_core::ChainCommunicationError::from_other_str(&format!(
                "Invalid tx hash format: {}",
                e
            ))
        })?;

        // Pad to 64 bytes if needed
        let mut padded_bytes = [0u8; 64];
        let start_pos = 64 - hash_bytes.len();
        padded_bytes[start_pos..].copy_from_slice(&hash_bytes);
        let tx_hash_512 = H512::from_slice(&padded_bytes);

        // Use existing CwMailboxDispatchIndexer implementation
        let messages_with_meta = self.indexer.fetch_logs_by_tx_hash(tx_hash_512).await?;

        // Extract just the messages
        let messages: Vec<HyperlaneMessage> = messages_with_meta
            .into_iter()
            .map(|(indexed_msg, _log_meta)| indexed_msg.inner().clone())
            .collect();

        Ok(messages)
    }

    fn domain(&self) -> u32 {
        self.domain
    }
}
