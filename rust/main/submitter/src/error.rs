#![allow(dead_code)]

use hyperlane_base::db::DbError;

use crate::transaction::Transaction;

#[derive(Debug, thiserror::Error)]
pub enum SubmitterError {
    #[error("Network error: {0}")]
    NetworkError(String),
    #[error("Transaction error: {0}")]
    TxSubmissionError(String),
    #[error("This transaction has already been broadcast")]
    TxAlreadyExists,
    #[error("The transaction reverted")]
    TxReverted,
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

impl SubmitterError {
    pub fn to_metrics_label(&self) -> String {
        match self {
            SubmitterError::NetworkError(_) => "NetworkError".to_string(),
            SubmitterError::TxSubmissionError(_) => "TxSubmissionError".to_string(),
            SubmitterError::TxAlreadyExists => "TxAlreadyExists".to_string(),
            SubmitterError::TxReverted => "TxReverted".to_string(),
            SubmitterError::ChannelSendFailure(_) => "ChannelSendFailure".to_string(),
            SubmitterError::ChannelClosed => "ChannelClosed".to_string(),
            SubmitterError::EyreError(_) => "EyreError".to_string(),
            SubmitterError::PayloadNotFound => "PayloadNotFound".to_string(),
            SubmitterError::SimulationFailed => "SimulationFailed".to_string(),
            SubmitterError::NonRetryableError(_) => "NonRetryableError".to_string(),
            SubmitterError::DbError(_) => "DbError".to_string(),
            SubmitterError::ChainCommunicationError(_) => "ChainCommunicationError".to_string(),
        }
    }
}

pub trait IsRetryable {
    fn is_retryable(&self) -> bool;
}

impl IsRetryable for SubmitterError {
    fn is_retryable(&self) -> bool {
        match self {
            SubmitterError::TxSubmissionError(_) => true,
            SubmitterError::NetworkError(_) => {
                // TODO: add logic to classify based on the error message
                false
            }
            SubmitterError::ChainCommunicationError(_) => {
                // TODO: add logic to classify based on the error message
                false
            }
            SubmitterError::EyreError(_) => {
                // TODO: add logic to classify based on the error message
                false
            }
            SubmitterError::ChannelSendFailure(_) => false,
            SubmitterError::NonRetryableError(_) => false,
            SubmitterError::TxReverted => false,
            SubmitterError::SimulationFailed => false,
            SubmitterError::ChannelClosed => false,
            SubmitterError::PayloadNotFound => false,
            SubmitterError::TxAlreadyExists => false,
            SubmitterError::DbError(_) => false,
        }
    }
}
