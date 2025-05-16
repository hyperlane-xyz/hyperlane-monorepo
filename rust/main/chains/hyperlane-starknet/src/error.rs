use hyperlane_core::ChainCommunicationError;
use starknet::{
    accounts::AccountError,
    core::{
        types::{FromByteArrayError, FromByteSliceError, FromStrError, ValueOutOfRangeError},
        utils::{CairoShortStringToFeltError, ParseCairoShortStringError},
    },
};
use std::fmt::Debug;

/// Errors from the crates specific to the hyperlane-starknet
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneStarknetError {
    /// Error during string conversion
    #[error(transparent)]
    StringConversionError(#[from] FromStrError),
    /// Short string conversion error
    #[error(transparent)]
    ShortStringConversionError(#[from] CairoShortStringToFeltError),
    /// String parsing error
    #[error(transparent)]
    StringParsingError(#[from] ParseCairoShortStringError),
    /// Error during bytes conversion
    #[error(transparent)]
    BytesConversionError(#[from] FromByteArrayError),
    /// Error during bytes slice conversion
    #[error(transparent)]
    BytesSliceConversionError(#[from] FromByteSliceError),
    /// Out of range value
    #[error(transparent)]
    ValueOutOfRangeError(#[from] ValueOutOfRangeError),
    /// Error during execution of a transaction
    #[error("Error during execution: {0}")]
    AccountError(String),
    /// Transaction receipt is invalid
    #[error("Invalid transaction receipt")]
    InvalidTransactionReceipt,
    /// Block is invalid
    #[error("Invalid block")]
    InvalidBlock,
    /// Error during contract call
    #[error(transparent)]
    ContractCallError(#[from] cainome::cairo_serde::Error),
    /// Error during a Starknet RPC call
    #[error(transparent)]
    ProviderError(#[from] starknet::providers::ProviderError),
    /// block number overflow
    #[error("Block number {0} overflows u32")]
    BlockNumberOverflow(u64),
    /// Other error
    #[error("{0}")]
    Other(String),
}

impl From<HyperlaneStarknetError> for ChainCommunicationError {
    fn from(value: HyperlaneStarknetError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}

impl HyperlaneStarknetError {
    /// Convert any error into a `HyperlaneStarknetError::Other`
    pub fn from_other<T: Debug>(err: T) -> Self {
        HyperlaneStarknetError::Other(format!("{:?}", err))
    }
}

impl<T: Debug> From<AccountError<T>> for HyperlaneStarknetError {
    fn from(value: AccountError<T>) -> Self {
        HyperlaneStarknetError::AccountError(format!("{:?}", value))
    }
}
