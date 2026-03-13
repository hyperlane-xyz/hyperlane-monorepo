use eyre::{eyre, Result};
use hyperlane_core::{ChainResult, HyperlaneMessage, H256};
use std::{collections::HashMap, sync::Arc};
use tracing::{debug, error};

/// Registry of providers for different chains
#[derive(Clone)]
pub struct ProviderRegistry {
    indexers: Arc<HashMap<String, Arc<dyn MailboxIndexer>>>,
}

/// Trait for chain-specific mailbox indexers
/// This trait abstracts over different protocol types (EVM, Cosmos, Sealevel, etc.)
#[async_trait::async_trait]
pub trait MailboxIndexer: Send + Sync {
    /// Fetch Hyperlane messages from a transaction by its hash
    /// tx_hash format is protocol-specific:
    /// - EVM: hex string (0x...)
    /// - Cosmos: hex or base64 string
    /// - Sealevel: base58 string
    async fn fetch_logs_by_tx_hash(&self, tx_hash: &str) -> ChainResult<Vec<HyperlaneMessage>>;

    /// Get the domain ID for this chain
    fn domain(&self) -> u32;
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            indexers: Arc::new(HashMap::new()),
        }
    }

    pub fn with_indexer(mut self, chain_name: String, indexer: Arc<dyn MailboxIndexer>) -> Self {
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

        // Fetch messages from transaction
        let messages = indexer.fetch_logs_by_tx_hash(tx_hash).await.map_err(|e| {
            error!(
                chain = %chain_name,
                tx_hash = %tx_hash,
                error = ?e,
                "Failed to fetch logs from transaction"
            );
            eyre!("Failed to fetch transaction logs: {}", e)
        })?;

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

        let destination_domain = message.destination;
        let message_id = message.id();

        debug!(
            chain = %chain_name,
            tx_hash = %tx_hash,
            message_id = ?message_id,
            destination_domain = destination_domain,
            "Successfully extracted message"
        );

        Ok(ExtractedMessage {
            message,
            origin_domain: indexer.domain(),
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
