use std::{io, path::PathBuf};

use hyperlane_core::{ChainCommunicationError, HyperlaneProtocolError};

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
    /// Custom error
    #[error("{0}")]
    Other(String),
}

impl From<DbError> for ChainCommunicationError {
    fn from(value: DbError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
