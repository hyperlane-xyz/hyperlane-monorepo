use ethers::providers::Middleware;
use hyperlane_core::{ChainResult, HyperlaneMessage, Indexer, H256, H512};
use hyperlane_ethereum::EthereumMailboxIndexer;
use std::str::FromStr;
use std::sync::Arc;

use super::extractor::MailboxIndexer;

/// EVM-specific implementation of MailboxIndexer
/// Wraps the existing EthereumMailboxIndexer to reuse all existing logic
pub struct EvmMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    indexer: Arc<EthereumMailboxIndexer<M>>,
    provider: Arc<M>,
    domain: u32,
}

impl<M> EvmMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    pub fn new(indexer: Arc<EthereumMailboxIndexer<M>>, provider: Arc<M>, domain: u32) -> Self {
        Self {
            indexer,
            provider,
            domain,
        }
    }
}

#[async_trait::async_trait]
impl<M> MailboxIndexer for EvmMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    async fn fetch_logs_by_tx_hash(&self, tx_hash: &str) -> ChainResult<Vec<HyperlaneMessage>> {
        // Parse hex string to H256
        let tx_hash_clean = tx_hash.trim_start_matches("0x");
        let hash_256 = H256::from_str(tx_hash_clean).map_err(|e| {
            hyperlane_core::ChainCommunicationError::from_other_str(&format!(
                "Invalid tx hash format: {}",
                e
            ))
        })?;

        // Convert H256 to H512 as expected by EthereumMailboxIndexer::fetch_logs_by_tx_hash
        // The H256 hash goes in the LAST 32 bytes (see hyperlane-core/src/types/conversions.rs:37-38)
        let tx_hash_512 = H512::from_slice(&{
            let mut bytes = [0u8; 64];
            bytes[32..].copy_from_slice(hash_256.as_bytes());
            bytes
        });

        // Use existing EthereumMailboxIndexer implementation
        // This method already handles:
        // - Fetching transaction receipt
        // - Filtering logs by contract address
        // - Decoding DispatchFilter events
        // - Converting to HyperlaneMessage
        // - Retry logic with call_and_retry_indefinitely
        let messages_with_meta = self.indexer.fetch_logs_by_tx_hash(tx_hash_512).await?;

        // Extract just the messages from (Indexed<HyperlaneMessage>, LogMeta) tuples
        let messages: Vec<HyperlaneMessage> = messages_with_meta
            .into_iter()
            .map(
                |(indexed_msg, _log_meta): (
                    hyperlane_core::Indexed<HyperlaneMessage>,
                    hyperlane_core::LogMeta,
                )| { indexed_msg.inner().clone() },
            )
            .collect();

        Ok(messages)
    }

    fn domain(&self) -> u32 {
        self.domain
    }
}
