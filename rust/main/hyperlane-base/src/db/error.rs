use std::{io, path::PathBuf};

use hyperlane_core::{ChainCommunicationError, HyperlaneProtocolError, InterchainGasPayment};

/// DB Error type
#[derive(thiserror::Error, Debug)]
pub enum DbError {
    /// Rocks DB Error
    #[error("{0}")]
    RockError(#[from] rocksdb::Error),
    #[error("Failed to open {path}, canonicalized as {canonicalized}: {source}")]
    /// Error opening the database
    OpeningError {
        /// Rocksdb error during opening
        #[source]
        source: Box<rocksdb::Error>,
        /// Raw database path provided
        path: PathBuf,
        /// Parsed path used
        canonicalized: PathBuf,
    },
    /// Could not parse the provided database path string
    #[error("Invalid database path supplied {1:?}; {0}")]
    InvalidDbPath(#[source] io::Error, String),
    /// Hyperlane Error
    #[error("{0}")]
    HyperlaneError(#[from] HyperlaneProtocolError),
    /// A sequenced gas payment disagrees with the payment stored for its sequence.
    #[error("{0}")]
    GasPaymentSequenceConflict(Box<GasPaymentSequenceConflict>),
    /// Custom error
    #[error("{0}")]
    Other(String),
}

/// Stored and incoming values for a conflicting gas payment sequence.
#[derive(thiserror::Error, Debug)]
#[error("Gas payment sequence {sequence} conflicts with stored payment: stored {stored:?} at block {stored_block:?}, incoming {incoming:?} at block {incoming_block}")]
pub struct GasPaymentSequenceConflict {
    /// Native gas payment sequence
    pub sequence: u32,
    /// Payment stored for the sequence, if any
    pub stored: Option<InterchainGasPayment>,
    /// Block stored for the sequence, if any
    pub stored_block: Option<u64>,
    /// Payment being indexed
    pub incoming: InterchainGasPayment,
    /// Block of the payment being indexed
    pub incoming_block: u64,
}

impl From<DbError> for ChainCommunicationError {
    fn from(value: DbError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
