use hyperlane_core::ChainCommunicationError;
use starknet::core::types::FromStrError;
use std::fmt::Debug;

/// Errors from the crates specific to the hyperlane-starknet
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneStarknetError {
    /// conversion error
    #[error(transparent)]
    ConversionError(#[from] FromStrError),
}

impl From<HyperlaneCosmosError> for ChainCommunicationError {
    fn from(value: HyperlaneCosmosError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
