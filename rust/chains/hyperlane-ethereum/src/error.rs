use ethers::providers::ProviderError;
use hyperlane_core::ChainCommunicationError;

/// Errors from the crates specific to the hyperlane-ethereum
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneEthereumError {
    /// provider Error
    #[error("{0}")]
    ProviderError(#[from] ProviderError),
}

impl From<HyperlaneEthereumError> for ChainCommunicationError {
    fn from(value: HyperlaneEthereumError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
