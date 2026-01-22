use hyperlane_tron::{TronProvider, TronProviderForLander};
use tracing::{error, info};

use hyperlane_core::ChainCommunicationError;

use crate::adapter::chains::tron::Precursor;
use crate::transaction::Transaction;
use crate::LanderError;

/// Classifies Tron transaction submission errors into appropriate LanderError variants
///
/// Based on Tron node error responses documented at:
/// https://developers.tron.network/docs/faq#12-broadcast-response-code
fn classify_tron_error(err: ChainCommunicationError) -> LanderError {
    let err_str = err.to_string();

    // Check for retryable errors (temporary conditions)
    if err_str.contains("SERVER_BUSY")
        || err_str.contains("NOT_ENOUGH_EFFECTIVE_CONNECTION")
        || err_str.contains("NO_CONNECTION")
        || err_str.contains("BLOCK_UNSOLIDIFIED")
        || err_str.contains("OTHER_ERROR")
    {
        return LanderError::TxSubmissionError(err_str);
    }

    if err_str.contains("BANDWITH_ERROR") {
        return LanderError::TxGasCapReached;
    }

    if err_str.contains("DUP_TRANSACTION_ERROR") {
        return LanderError::TxAlreadyExists;
    }

    // Check for non-retryable errors (permanent failures)
    if err_str.contains("SIGERROR")
        || err_str.contains("TAPOS_ERROR")
        || err_str.contains("TOO_BIG_TRANSACTION_ERROR")
        || err_str.contains("TRANSACTION_EXPIRATION_ERROR")
        || err_str.contains("CONTRACT_EXE_ERROR")
    {
        return LanderError::NonRetryableError(err_str);
    }

    // Default: convert to ChainCommunicationError for generic handling
    LanderError::ChainCommunicationError(err)
}

/// Submits a Tron transaction
pub async fn submit_transaction<P: TronProviderForLander>(
    provider: &P,
    tx: &mut Transaction,
) -> Result<(), LanderError> {
    let tx_precursor = tx.precursor();

    info!(?tx, "submitting Tron transaction");

    // Submit transaction
    let tx_hash = provider
        .submit_tx(&tx_precursor.tx)
        .await
        .map_err(classify_tron_error)?;

    tx.last_submission_attempt = Some(chrono::Utc::now());

    // Store transaction hash
    if !tx.tx_hashes.contains(&tx_hash.into()) {
        tx.tx_hashes.push(tx_hash.into());
    }

    info!(tx_uuid=?tx.uuid, ?tx_hash, "submitted Tron transaction");
    Ok(())
}

#[cfg(test)]
mod tests;
