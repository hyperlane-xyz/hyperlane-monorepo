use hyperlane_core::{HyperlaneMessage, Indexer, H256, H512};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tracing::{debug, error};

/// Error returned by [`extract_messages`].
#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    /// The receipt lookup timed out. Clients should treat this as transient and retry.
    #[error("Transaction receipt not found within timeout for tx hash: {0}")]
    Timeout(String),
    /// A permanent extraction failure (bad tx hash, no Dispatch events, etc.).
    #[error("{0}")]
    Failed(String),
}

/// Extract all Hyperlane messages from a transaction hash on a specific chain.
///
/// Returns [`ExtractError::Timeout`] when the receipt lookup times out (transient — client
/// should retry). Returns [`ExtractError::Failed`] for permanent errors such as an invalid tx
/// hash or a tx with no Dispatch events.
pub async fn extract_messages(
    indexers: &HashMap<String, Arc<dyn Indexer<HyperlaneMessage>>>,
    chain_name: &str,
    tx_hash: &str,
) -> Result<Vec<ExtractedMessage>, ExtractError> {
    // Get indexer for chain
    let indexer = indexers.get(chain_name).ok_or_else(|| {
        ExtractError::Failed(format!("Chain not found in registry: {chain_name}"))
    })?;

    debug!(
        chain = %chain_name,
        tx_hash = %tx_hash,
        "Extracting message from transaction"
    );

    // Parse tx hash using protocol-specific method
    let tx_hash_512 = indexer
        .parse_tx_hash(tx_hash)
        .map_err(|e| ExtractError::Failed(format!("Invalid tx hash format: {e}")))?;

    // Fetch messages and CCTP V2 flag from the transaction in a single receipt lookup.
    // fetch_logs_and_cctp_v2 retries indefinitely on missing receipts; the 5-second
    // timeout here bounds both the log fetch and the CCTP check so an invalid or
    // not-yet-confirmed tx hash returns a clean error instead of burning the entire
    // 10-second outer handler timeout.
    let (messages_with_meta, is_cctp_v2) = tokio::time::timeout(
        Duration::from_secs(5),
        indexer.fetch_logs_and_cctp_v2(tx_hash_512),
    )
    .await
    .map_err(|_| {
        error!(
            chain = %chain_name,
            tx_hash = %tx_hash,
            "Timed out waiting for transaction receipt"
        );
        ExtractError::Timeout(tx_hash.to_string())
    })?
    .map_err(|e| {
        error!(
            chain = %chain_name,
            tx_hash = %tx_hash,
            error = ?e,
            "Failed to fetch logs from transaction"
        );
        ExtractError::Failed(format!("Failed to fetch transaction logs: {e}"))
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
        return Err(ExtractError::Failed(
            "No Hyperlane Dispatch events found in transaction".to_string(),
        ));
    }

    debug!(
        chain = %chain_name,
        tx_hash = %tx_hash,
        message_count = messages.len(),
        "Successfully extracted messages from transaction"
    );

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
            let message_id = message.id();

            debug!(
                chain = %chain_name,
                tx_hash = %tx_hash,
                message_id = ?message_id,
                origin_domain = message.origin,
                destination_domain = message.destination,
                "Extracted message"
            );

            ExtractedMessage {
                message,
                message_id,
                is_cctp_v2,
                tx_hash: tx_hash_512,
            }
        })
        .collect();

    Ok(extracted_messages)
}

#[derive(Debug, Clone)]
pub struct ExtractedMessage {
    pub message: HyperlaneMessage,
    pub message_id: H256,
    /// True when every Dispatch in the transaction has a corresponding CCTP V2 `DepositForBurn`
    /// event. False for mixed transactions (some CCTP, some unrelated dispatches) so that
    /// unrelated messages are never routed through the fail-fast CCTP path.
    pub is_cctp_v2: bool,
    /// The origin transaction hash, used by the ccip-server to skip GraphQL lookup.
    pub tx_hash: H512,
}
