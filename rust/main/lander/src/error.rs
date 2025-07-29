use hyperlane_base::db::DbError;

use crate::transaction::Transaction;

#[derive(Debug, thiserror::Error)]
pub enum LanderError {
    #[error("Network error: {0}")]
    NetworkError(String),
    #[error("Transaction error: {0}")]
    TxSubmissionError(String),
    /// This error means that a transaction was already submitted
    /// For EVM, it may mean that nonce got clashed on the chain.
    #[error("This transaction has already been broadcast")]
    TxAlreadyExists,
    #[error("The transaction reverted")]
    TxReverted,
    #[error("The transaction hash was not found: {0}")]
    TxHashNotFound(String),
    #[error("Failed to send over a channel {0}")]
    ChannelSendFailure(#[from] tokio::sync::mpsc::error::SendError<Transaction>),
    #[error("Channel closed")]
    ChannelClosed,
    #[error("{0}")]
    EyreError(#[from] eyre::Report),
    #[error("Payload not found")]
    PayloadNotFound,
    #[error("Transaction simulation failed, reason: {0:?}")]
    SimulationFailed(Vec<String>),
    #[error("Transaction estimation failed")]
    EstimationFailed,
    #[error("Non-retryable error: {0}")]
    NonRetryableError(String),

    // TODO: fully decouple from these crates
    #[error("DB error {0}")]
    DbError(#[from] DbError),
    #[error("Chain communication error {0}")]
    ChainCommunicationError(#[from] hyperlane_core::ChainCommunicationError),
}

impl LanderError {
    pub fn to_metrics_label(&self) -> String {
        use LanderError::*;

        match self {
            NetworkError(_) => "NetworkError".to_string(),
            TxSubmissionError(_) => "TxSubmissionError".to_string(),
            TxAlreadyExists => "TxAlreadyExists".to_string(),
            TxReverted => "TxReverted".to_string(),
            ChannelSendFailure(_) => "ChannelSendFailure".to_string(),
            ChannelClosed => "ChannelClosed".to_string(),
            EyreError(_) => "EyreError".to_string(),
            PayloadNotFound => "PayloadNotFound".to_string(),
            SimulationFailed(_) => "SimulationFailed".to_string(),
            EstimationFailed => "EstimationFailed".to_string(),
            NonRetryableError(_) => "NonRetryableError".to_string(),
            DbError(_) => "DbError".to_string(),
            ChainCommunicationError(_) => "ChainCommunicationError".to_string(),
            TxHashNotFound(_) => "TxHashNotFound".to_string(),
        }
    }
}

const EVM_GAS_UNDERPRICED_ERRORS: [&str; 4] = [
    "replacement transaction underpriced",
    "already known",
    "Fair pubdata price too high",
    // seen on Sei
    "insufficient fee",
];

const SVM_BLOCKHASH_NOT_FOUND_ERROR: &str = "Blockhash not found";

// this error is returned randomly by the `TestTokenRecipient`,
// to simulate delivery errors
const SIMULATED_DELIVERY_FAILURE_ERROR: &str = "block hash ends in 0";

pub trait IsRetryable {
    fn is_retryable(&self) -> bool;
}

impl IsRetryable for LanderError {
    fn is_retryable(&self) -> bool {
        use LanderError::*;

        match self {
            TxSubmissionError(_) => true,
            NetworkError(_) => {
                // TODO: add logic to classify based on the error message
                false
            }
            ChainCommunicationError(err) => {
                if err.to_string().contains(SIMULATED_DELIVERY_FAILURE_ERROR) {
                    return true;
                }
                if EVM_GAS_UNDERPRICED_ERRORS
                    .iter()
                    .any(|&e| err.to_string().contains(e))
                {
                    return true;
                }

                if err.to_string().contains(SVM_BLOCKHASH_NOT_FOUND_ERROR) {
                    return true;
                }
                // TODO: add logic to classify based on the error message
                false
            }
            EyreError(_) => {
                // TODO: add logic to classify based on the error message
                false
            }
            SimulationFailed(reasons) => reasons
                .iter()
                .all(|r| r.contains(SIMULATED_DELIVERY_FAILURE_ERROR)),
            ChannelSendFailure(_)
            | NonRetryableError(_)
            | TxReverted
            | EstimationFailed
            | ChannelClosed
            | PayloadNotFound
            | TxAlreadyExists
            | DbError(_)
            | TxHashNotFound(_) => false,
        }
    }
}
