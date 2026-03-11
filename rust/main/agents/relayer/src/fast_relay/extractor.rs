use std::sync::Arc;

use ethers::providers::Middleware;
use hyperlane_core::{ChainResult, ContractLocator, HyperlaneMessage, Indexer, H256, H512};
use hyperlane_ethereum::{EthereumMailboxIndexer, EthereumReorgPeriod};
use tracing::{debug, warn};

/// Extracted message information from a transaction
#[derive(Debug, Clone)]
pub struct ExtractedMessage {
    /// The Hyperlane message
    pub message: HyperlaneMessage,
    /// The message ID (hash of the message)
    pub message_id: H256,
    /// Origin transaction hash
    pub tx_hash: H512,
}

/// Extract Hyperlane Dispatch event from a transaction
///
/// This function fetches the transaction receipt and extracts the first
/// Hyperlane Dispatch event found, which contains the message to be relayed.
pub async fn extract_hyperlane_message<M>(
    tx_hash: H512,
    provider: Arc<M>,
    locator: &ContractLocator<'_>,
) -> ChainResult<Option<ExtractedMessage>>
where
    M: Middleware + 'static,
{
    debug!(?tx_hash, ?locator, "Extracting Hyperlane message from transaction");

    // Create indexer with zero reorg period (tx is already finalized if user has it)
    let indexer = EthereumMailboxIndexer::new(
        provider,
        locator,
        EthereumReorgPeriod::Blocks(0),
    );

    // Fetch messages from the transaction
    let messages: Vec<(hyperlane_core::Indexed<HyperlaneMessage>, hyperlane_core::LogMeta)> =
        indexer.fetch_logs_by_tx_hash(tx_hash).await?;

    if messages.is_empty() {
        warn!(?tx_hash, "No Dispatch events found in transaction");
        return Ok(None);
    }

    if messages.len() > 1 {
        warn!(
            ?tx_hash,
            count = messages.len(),
            "Multiple Dispatch events found, using first one"
        );
    }

    // Extract the first message
    let (indexed_message, log_meta) = &messages[0];
    let message = indexed_message.inner().clone();
    let message_id = message.id();

    debug!(
        ?message_id,
        ?tx_hash,
        origin = message.origin,
        destination = message.destination,
        nonce = message.nonce,
        block_number = log_meta.block_number,
        "Successfully extracted Hyperlane message"
    );

    Ok(Some(ExtractedMessage {
        message,
        message_id,
        tx_hash,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extracted_message() {
        // Test that message ID calculation works
        let message = HyperlaneMessage {
            version: 3,
            nonce: 1,
            origin: 1,
            sender: H256::zero(),
            destination: 2,
            recipient: H256::zero(),
            body: vec![],
        };

        let message_id = message.id();
        assert_ne!(message_id, H256::zero());

        let extracted = ExtractedMessage {
            message: message.clone(),
            message_id,
            tx_hash: H512::zero(),
        };

        assert_eq!(extracted.message_id, message.id());
    }
}
