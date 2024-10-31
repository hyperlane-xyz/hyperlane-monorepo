use hyperlane_core::{ChainCommunicationError, H512};
use solana_client::client_error::ClientError;
use solana_sdk::pubkey::ParsePubkeyError;
use solana_transaction_status::EncodedTransaction;

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
    ClientError(#[from] ClientError),
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
    UnsupportedTransactionEncoding(EncodedTransaction),
    /// Unsigned transaction
    #[error("{0}")]
    UnsignedTransaction(H512),
    /// Incorrect transaction
    #[error("received incorrect transaction, expected hash: {0:?}, received hash: {1:?}")]
    IncorrectTransaction(Box<H512>, Box<H512>),
}

impl From<HyperlaneSealevelError> for ChainCommunicationError {
    fn from(value: HyperlaneSealevelError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
