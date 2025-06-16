#![allow(dead_code)]

use hyperlane_base::db::DbError;

use crate::transaction::Transaction;

#[derive(Debug, thiserror::Error)]
pub enum LanderError {
    #[error("Network error: {0}")]
    NetworkError(String),
    #[error("Transaction error: {0}")]
    TxSubmissionError(String),
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
    #[error("Transaction simulation failed")]
    SimulationFailed,
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
        match self {
            LanderError::NetworkError(_) => "NetworkError".to_string(),
            LanderError::TxSubmissionError(_) => "TxSubmissionError".to_string(),
            LanderError::TxAlreadyExists => "TxAlreadyExists".to_string(),
            LanderError::TxReverted => "TxReverted".to_string(),
            LanderError::ChannelSendFailure(_) => "ChannelSendFailure".to_string(),
            LanderError::ChannelClosed => "ChannelClosed".to_string(),
            LanderError::EyreError(_) => "EyreError".to_string(),
            LanderError::PayloadNotFound => "PayloadNotFound".to_string(),
            LanderError::SimulationFailed => "SimulationFailed".to_string(),
            LanderError::NonRetryableError(_) => "NonRetryableError".to_string(),
            LanderError::DbError(_) => "DbError".to_string(),
            LanderError::ChainCommunicationError(_) => "ChainCommunicationError".to_string(),
            LanderError::TxHashNotFound(_) => "TxHashNotFound".to_string(),
        }
    }
}

const GAS_UNDERPRICED_ERRORS: [&str; 4] = [
    "replacement transaction underpriced",
    "already known",
    "Fair pubdata price too high",
    // seen on Sei
    "insufficient fee",
];

pub trait IsRetryable {
    fn is_retryable(&self) -> bool;
}

impl IsRetryable for LanderError {
    fn is_retryable(&self) -> bool {
        match self {
            LanderError::TxSubmissionError(_) => true,
            LanderError::NetworkError(_) => {
                // TODO: add logic to classify based on the error message
                false
            }
            LanderError::ChainCommunicationError(err) => {
                // this error is returned randomly by the `TestTokenRecipient`,
                // to simulate delivery errors
                if err.to_string().contains("block hash ends in 0") {
                    return true;
                }
                if GAS_UNDERPRICED_ERRORS
                    .iter()
                    .any(|&e| err.to_string().contains(e))
                {
                    return true;
                }
                // TODO: add logic to classify based on the error message
                false
            }
            LanderError::EyreError(_) => {
                // TODO: add logic to classify based on the error message
                false
            }
            LanderError::ChannelSendFailure(_) => false,
            LanderError::NonRetryableError(_) => false,
            LanderError::TxReverted => false,
            LanderError::SimulationFailed => false,
            LanderError::ChannelClosed => false,
            LanderError::PayloadNotFound => false,
            LanderError::TxAlreadyExists => false,
            LanderError::DbError(_) => false,
            LanderError::TxHashNotFound(_) => false,
        }
    }
}
