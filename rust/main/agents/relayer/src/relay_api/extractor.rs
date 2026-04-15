use eyre::{eyre, Result};
use hyperlane_core::{HyperlaneMessage, Indexer, H256};
use std::{collections::HashMap, sync::Arc};
use tracing::{debug, error, warn};

/// Extract all Hyperlane messages from a transaction hash on a specific chain
pub async fn extract_messages(
    indexers: &HashMap<String, Arc<dyn Indexer<HyperlaneMessage>>>,
    chain_name: &str,
    tx_hash: &str,
) -> Result<Vec<ExtractedMessage>> {
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

    debug!(
        chain = %chain_name,
        tx_hash = %tx_hash,
        message_count = messages.len(),
        "Successfully extracted messages from transaction"
    );

    // Check once per tx whether this is a CCTP fast transfer.
    // Errors are treated as false — the relay API will reject the request below.
    let is_cctp_v2 = indexer.is_cctp_v2(tx_hash_512).await.unwrap_or_else(|e| {
        warn!(
            chain = %chain_name,
            tx_hash = %tx_hash,
            error = ?e,
            "Failed to check for CCTP V2 burn event, treating as non-CCTP"
        );
        false
    });

    debug!(
        chain = %chain_name,
        tx_hash = %tx_hash,
        is_cctp_v2,
        "CCTP V2 burn event check result"
    );

    // Convert all messages to ExtractedMessage structs
    let extracted_messages: Vec<ExtractedMessage> = messages
        .into_iter()
        .map(|message| {
            let origin_domain = message.origin;
            let destination_domain = message.destination;
            let message_id = message.id();

            debug!(
                chain = %chain_name,
                tx_hash = %tx_hash,
                message_id = ?message_id,
                origin_domain = origin_domain,
                destination_domain = destination_domain,
                "Extracted message"
            );

            ExtractedMessage {
                message,
                origin_domain,
                destination_domain,
                message_id,
                is_cctp_v2,
            }
        })
        .collect();

    Ok(extracted_messages)
}

#[derive(Debug, Clone)]
pub struct ExtractedMessage {
    pub message: HyperlaneMessage,
    pub origin_domain: u32,
    pub destination_domain: u32,
    pub message_id: H256,
    /// True when the transaction contains a Circle CCTP V2 `DepositForBurn` event.
    pub is_cctp_v2: bool,
}
