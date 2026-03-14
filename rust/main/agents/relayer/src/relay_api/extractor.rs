use eyre::{eyre, Result};
use hyperlane_core::{HyperlaneMessage, Indexer, H256, H512};
use std::{collections::HashMap, sync::Arc};
use tracing::{debug, error};

/// Registry of providers for different chains
#[derive(Clone)]
pub struct ProviderRegistry {
    indexers: Arc<HashMap<String, Arc<dyn Indexer<HyperlaneMessage>>>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            indexers: Arc::new(HashMap::new()),
        }
    }

    pub fn with_indexer(
        mut self,
        chain_name: String,
        indexer: Arc<dyn Indexer<HyperlaneMessage>>,
    ) -> Self {
        Arc::get_mut(&mut self.indexers)
            .expect("Cannot modify registry after cloning")
            .insert(chain_name, indexer);
        self
    }

    pub async fn extract_message(
        &self,
        chain_name: &str,
        tx_hash: &str,
    ) -> Result<ExtractedMessage> {
        // Get indexer for chain
        let indexer = self
            .indexers
            .get(chain_name)
            .ok_or_else(|| eyre!("Chain not found in registry: {}", chain_name))?;

        debug!(
            chain = %chain_name,
            tx_hash = %tx_hash,
            "Extracting message from transaction"
        );

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

        // Fetch messages from transaction
        let messages_with_meta = indexer
            .fetch_logs_by_tx_hash(tx_hash_512)
            .await
            .map_err(|e| {
                error!(
                    chain = %chain_name,
                    tx_hash = %tx_hash,
                    error = ?e,
                    "Failed to fetch logs from transaction"
                );
                eyre!("Failed to fetch transaction logs: {}", e)
            })?;

        // Extract just the messages
        let messages: Vec<HyperlaneMessage> = messages_with_meta
            .into_iter()
            .map(|(indexed_msg, _log_meta)| indexed_msg.inner().clone())
            .collect();

        if messages.is_empty() {
            error!(
                chain = %chain_name,
                tx_hash = %tx_hash,
                "No Hyperlane Dispatch events found in transaction"
            );
            return Err(eyre!("No Hyperlane Dispatch events found in transaction"));
        }

        // For now, take the first message (most common case)
        // TODO: Handle multiple messages in single tx if needed
        let message = messages.into_iter().next().unwrap();

        let origin_domain = message.origin;
        let destination_domain = message.destination;
        let message_id = message.id();

        debug!(
            chain = %chain_name,
            tx_hash = %tx_hash,
            message_id = ?message_id,
            origin_domain = origin_domain,
            destination_domain = destination_domain,
            "Successfully extracted message"
        );

        Ok(ExtractedMessage {
            message,
            origin_domain,
            destination_domain,
            message_id,
        })
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct ExtractedMessage {
    pub message: HyperlaneMessage,
    pub origin_domain: u32,
    pub destination_domain: u32,
    pub message_id: H256,
}
