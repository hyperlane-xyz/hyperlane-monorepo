use hyperlane_core::{ChainCommunicationError, H512};
use solana_client::client_error::ClientError;
use solana_sdk::pubkey::ParsePubkeyError;
use solana_transaction_status::{EncodedTransaction, UiMessage};

/// Errors from the crates specific to the hyperlane-sealevel
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneSealevelError {
    /// ParsePubkeyError error
    #[error("{0}")]
    ParsePubkeyError(#[from] ParsePubkeyError),
    /// ClientError error
    #[error("{0}")]
    ClientError(#[from] Box<ClientError>),
    /// Decoding error
    #[error("{0}")]
    Decoding(#[from] solana_sdk::bs58::decode::Error),
    /// No transaction in block error
    #[error("{0}")]
    NoTransactions(String),
    /// Too many transactions of particular content in block
    #[error("{0}")]
    TooManyTransactions(String),
    /// Unsupported transaction encoding
    #[error("{0:?}")]
    UnsupportedTransactionEncoding(Box<EncodedTransaction>),
    /// Unsupported message encoding
    #[error("{0:?}")]
    UnsupportedMessageEncoding(Box<UiMessage>),
    /// Unsigned transaction
    #[error("{0}")]
    UnsignedTransaction(Box<H512>),
    /// Incorrect transaction
    #[error("received incorrect transaction, expected hash: {0:?}, received hash: {1:?}")]
    IncorrectTransaction(Box<H512>, Box<H512>),
    /// Empty metadata
    #[error("received empty metadata in transaction")]
    EmptyMetadata,
    /// Empty compute units consumed
    #[error("received empty compute units consumed in transaction")]
    EmptyComputeUnitsConsumed,
    /// Too many non-native programs
    #[error("transaction contains too many non-native programs, hash: {0:?}")]
    TooManyNonNativePrograms(Box<H512>),
    /// No non-native programs
    #[error("transaction contains no non-native programs, hash: {0:?}")]
    NoNonNativePrograms(Box<H512>),
}

impl HyperlaneSealevelError {
    /// Whether this error means a specific event's log meta could not be
    /// resolved from the block recorded on its storage account (the block does
    /// not contain the expected transaction after filtering, or contains more
    /// than one). These are non-retryable: the block will never contain the
    /// transaction, so sequence-aware indexing should fall back to basic log
    /// meta and advance rather than rewinding on the same sequence forever.
    pub fn is_log_meta_unresolvable(&self) -> bool {
        matches!(self, Self::NoTransactions(_) | Self::TooManyTransactions(_))
    }
}

impl From<HyperlaneSealevelError> for ChainCommunicationError {
    fn from(value: HyperlaneSealevelError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_meta_unresolvable_errors_are_non_retryable() {
        assert!(HyperlaneSealevelError::NoTransactions("x".into()).is_log_meta_unresolvable());
        assert!(HyperlaneSealevelError::TooManyTransactions("x".into()).is_log_meta_unresolvable());
    }

    #[test]
    fn other_errors_are_not_log_meta_unresolvable() {
        assert!(!HyperlaneSealevelError::EmptyMetadata.is_log_meta_unresolvable());
        assert!(!HyperlaneSealevelError::EmptyComputeUnitsConsumed.is_log_meta_unresolvable());
        assert!(
            !HyperlaneSealevelError::UnsignedTransaction(Box::new(H512::zero()))
                .is_log_meta_unresolvable()
        );
    }
}
