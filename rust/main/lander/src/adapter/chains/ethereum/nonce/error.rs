use hyperlane_base::db::DbError;
use hyperlane_core::{ChainCommunicationError, U256};

use crate::transaction::TransactionUuid;

pub(crate) type NonceResult<T> = Result<T, NonceError>;

#[derive(Debug, thiserror::Error)]
pub(crate) enum NonceError {
    /// An error occurred while storing to or retrieving from a database.
    #[error("Database error: {0}")]
    DatabaseError(DbError),
    /// Provider error
    #[error("Provider error")]
    ProviderError(ChainCommunicationError),
}

impl From<DbError> for NonceError {
    fn from(error: DbError) -> Self {
        NonceError::DatabaseError(error)
    }
}
