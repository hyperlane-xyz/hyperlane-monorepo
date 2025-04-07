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

    // TODO: fully decouple from these crates
    #[error("DB error {0}")]
    DbError(#[from] DbError),
    #[error("Chain communication error {0}")]
    ChainCommunicationError(#[from] hyperlane_core::ChainCommunicationError),
}
