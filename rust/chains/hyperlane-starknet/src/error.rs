use hyperlane_core::ChainCommunicationError;
use starknet::core::types::{FromByteArrayError, FromStrError};
use std::fmt::Debug;

/// Errors from the crates specific to the hyperlane-starknet
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneStarknetError {
    #[error(transparent)]
    StringConversionError(#[from] FromStrError),
    #[error(transparent)]
    BytesConversionError(#[from] FromByteArrayError),
    #[error("Error during execution: {0}")]
    AccountError(String),
    #[error("Invalid transaction receipt")]
    InvalidTransactionReceipt,
    #[error("Invalid block")]
    InvalidBlock,
    #[error(transparent)]
    ContractCallError(#[from] cainome::cairo_serde::Error),
    #[error(transparent)]
    ProviderError(#[from] starknet::providers::ProviderError),
}

impl From<HyperlaneStarknetError> for ChainCommunicationError {
    fn from(value: HyperlaneStarknetError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
