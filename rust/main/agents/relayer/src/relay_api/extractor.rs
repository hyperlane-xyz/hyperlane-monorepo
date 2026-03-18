use eyre::{eyre, Result};
use hyperlane_core::{HyperlaneMessage, Indexer, H256};
use std::{collections::HashMap, sync::Arc};
use tracing::{debug, error};

/// Extract a Hyperlane message from a transaction hash on a specific chain
pub async fn extract_message(
    indexers: &HashMap<String, Arc<dyn Indexer<HyperlaneMessage>>>,
    chain_name: &str,
    tx_hash: &str,
) -> Result<ExtractedMessage> {
    // Get indexer for chain
    let indexer = indexers
        .get(chain_name)
        .ok_or_else(|| eyre!("Chain not found in registry: {}", chain_name))?;

    debug!(
        chain = %chain_name,
        tx_hash = %tx_hash,
        "Extracting message from transaction"
    );

    // Parse tx hash using protocol-specific method
    let tx_hash_512 = indexer
        .parse_tx_hash(tx_hash)
        .map_err(|e| eyre!("Invalid tx hash format: {}", e))?;

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

#[derive(Debug, Clone)]
pub struct ExtractedMessage {
    pub message: HyperlaneMessage,
    pub origin_domain: u32,
    pub destination_domain: u32,
    pub message_id: H256,
}
