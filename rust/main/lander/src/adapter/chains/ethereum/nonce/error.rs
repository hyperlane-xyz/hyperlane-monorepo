use hyperlane_base::db::DbError;
use hyperlane_core::U256;

use crate::transaction::TransactionUuid;

pub(crate) type NonceResult<T> = Result<T, NonceError>;

#[derive(Debug, thiserror::Error)]
pub(crate) enum NonceError {
    /// An error occurred while storing to or retrieving from a database.
    #[error("Database error: {0}")]
    DatabaseError(DbError),
    /// The nonce is already assigned to a transaction.
    #[error("Nonce {0} is assigned to transactions {1:?} and {2:?}")]
    NonceAssignedToMultipleTransactions(U256, TransactionUuid, TransactionUuid),
}

impl From<DbError> for NonceError {
    fn from(error: DbError) -> Self {
        NonceError::DatabaseError(error)
    }
}
