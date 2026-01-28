use tracing::{error, info};

use hyperlane_aleo::AleoProviderForLander;
use hyperlane_core::ChainCommunicationError;

use crate::transaction::Transaction;
use crate::LanderError;

use super::super::transaction::Precursor;

/// Classifies Aleo transaction submission errors into appropriate LanderError variants
///
/// Based on Aleo node error responses documented at:
/// https://gist.github.com/iamalwaysuncomfortable/d79660cd609be50866fef16b05cbcde2
///
/// # Error Classification
///
/// **Retryable errors (TxSubmissionError):**
/// - Rate limiting (429)
/// - Node overload (too many verifications)
/// - Node syncing
///
/// **Non-retryable errors:**
/// - Transaction already exists in ledger → TxAlreadyExists
/// - Duplicate inputs/outputs (spent records) → NonRetryableError
/// - Malformed transactions → NonRetryableError
/// - Size limit exceeded → NonRetryableError
/// - Invalid transaction ID → NonRetryableError
fn classify_aleo_error(err: ChainCommunicationError) -> LanderError {
    let err_str = err.to_string();

    // Check for retryable errors (temporary conditions)
    if err_str.contains("Too many requests")
        || err_str.contains("Too many execution verifications in progress")
        || err_str.contains("Too many deploy verifications in progress")
        || err_str.contains("Unable to validate transaction (node is syncing)")
    {
        return LanderError::TxSubmissionError(err_str);
    }

    // Check for transaction already exists in ledger
    if err_str.contains("already exists in the ledger") {
        return LanderError::TxAlreadyExists;
    }

    // Check for non-retryable errors (permanent failures)
    // Note: "Found a duplicate" means inputs were spent by another transaction
    if err_str.contains("Transaction size exceeds the byte limit")
        || err_str.contains("Invalid Transaction Data")
        || err_str.contains("is not well-formed")
        || err_str.contains("Incorrect transaction ID")
        || err_str.contains("Found a duplicate")
    {
        return LanderError::NonRetryableError(err_str);
    }

    // Default: convert to ChainCommunicationError for generic handling
    LanderError::ChainCommunicationError(err)
}

/// Submits an Aleo transaction
///
/// # Arguments
/// * `provider` - The Aleo provider to use for submission
/// * `tx` - The transaction to submit (will be mutated to store tx hash)
///
/// # Returns
/// * `Ok(())` - Transaction successfully submitted
/// * `Err(LanderError)` - Submission failed
pub async fn submit_transaction<P: AleoProviderForLander>(
    provider: &P,
    tx: &mut Transaction,
) -> Result<(), LanderError> {
    let tx_precursor = tx.precursor();

    info!(?tx, "submitting Aleo transaction");

    // Submit transaction
    let tx_hash = provider
        .submit_tx(
            &tx_precursor.program_id,
            &tx_precursor.function_name,
            tx_precursor.inputs.clone(),
        )
        .await
        .map_err(classify_aleo_error)?;

    // Store transaction hash
    if !tx.tx_hashes.contains(&tx_hash) {
        tx.tx_hashes.push(tx_hash);
    }

    info!(tx_uuid=?tx.uuid, ?tx_hash, "submitted Aleo transaction");
    Ok(())
}

#[cfg(test)]
mod tests;
