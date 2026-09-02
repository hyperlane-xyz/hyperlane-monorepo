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
/// 3. If not found, assume pending inclusion
pub async fn get_tx_hash_status<P: AleoProviderForLander>(
    provider: &Arc<P>,
    hash: H512,
) -> Result<TransactionStatus, LanderError> {
    debug!("Checking status of tx, hash: {:?}", hash);

    // First, check if the transaction is confirmed on-chain
    if provider
        .request_confirmed_transaction(hash)
        .await?
        .is_some()
    {
        // Transaction is confirmed - report as finalized
        // Once we introduce transaction drop reasons Rejected and Reverted,
        // we shall check if a confirmed Aleo transaction was rejected.
        // Meanwhile, we shall report transaction as finalized and use payload
        // success criteria to confirm if they have landed on the chain.
        debug!("Transaction is finalized, hash: {:?}", hash);
        return Ok(TransactionStatus::Finalized);
    }

    debug!("Transaction is not finalized, hash: {}", hash);

    // Not confirmed yet, check if it's in the mempool (unconfirmed)
    if provider
        .request_unconfirmed_transaction(hash)
        .await?
        .is_some()
    {
        // Transaction is in the mempool, waiting to be included in a block
        debug!("Transaction found in mempool, hash: {:?}", hash);
        return Ok(TransactionStatus::Mempool);
    }

    // The transaction is not found in confirmed transactions or mempool
    // This could mean:
    // 1. Transaction was just submitted and not yet propagated
    // 2. Transaction was dropped from the mempool
    // Provider errors are propagated instead of being mistaken for absence.
    debug!(
        "Transaction not found in confirmed or unconfirmed, hash: {:?}",
        hash
    );
    Ok(TransactionStatus::PendingInclusion)
}

#[cfg(test)]
mod tests;
