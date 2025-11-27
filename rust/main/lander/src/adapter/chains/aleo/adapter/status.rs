use std::sync::Arc;

use tracing::debug;

use hyperlane_aleo::AleoProviderForLander;
use hyperlane_core::H512;

use crate::{LanderError, TransactionDropReason, TransactionStatus};

/// Check the status of a transaction on the Aleo network
///
/// This function checks the transaction status in the following order:
/// 1. Check if the transaction is confirmed on-chain (accepted or rejected)
/// 2. Check if the transaction is in the mempool (unconfirmed)
/// 3. If not found, assume it's pending inclusion
pub async fn get_tx_hash_status<P: AleoProviderForLander>(
    provider: &Arc<P>,
    hash: H512,
) -> Result<TransactionStatus, LanderError> {
    // First, check if transaction is confirmed on-chain
    if let Ok(confirmed_tx) = provider.get_confirmed_transaction(hash).await {
        // Transaction is confirmed - check if it was rejected or accepted
        return if confirmed_tx.is_rejected() {
            Ok(TransactionStatus::Dropped(
                TransactionDropReason::DroppedByChain,
            ))
        } else {
            // Transaction is confirmed and accepted
            Ok(TransactionStatus::Finalized)
        };
    }

    // Not confirmed yet, check if it's in the mempool (unconfirmed)
    if let Ok(_unconfirmed_tx) = provider.get_unconfirmed_transaction(hash).await {
        // Transaction is in mempool, waiting to be included in a block
        debug!("Transaction found in mempool: {}", hash);
        return Ok(TransactionStatus::Mempool);
    }

    // Transaction not found in confirmed transactions or mempool
    // This could mean:
    // 1. Transaction was just submitted and not yet propagated
    // 2. Transaction was dropped from mempool
    // 3. Network error
    debug!(
        "Transaction not found in confirmed or unconfirmed: {}",
        hash
    );
    Ok(TransactionStatus::PendingInclusion)
}

#[cfg(test)]
mod tests;
