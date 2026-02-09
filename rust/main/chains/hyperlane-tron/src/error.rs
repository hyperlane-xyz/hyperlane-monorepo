use hyperlane_core::ChainCommunicationError;

/// Errors from the crates specific to the hyperlane-tron
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneTronError {
    /// REST API error
    #[error("REST API error: {0}")]
    RestApiError(String),
    /// Missing raw data
    #[error("Missing raw data")]
    MissingRawData,
    /// Missing block header
    #[error("Missing block header")]
    MissingBlockHeader,
    /// Ethers-rs provider error
    #[error("Ethers provider error: {0}")]
    EthersProviderError(#[from] ethers::providers::ProviderError),
    /// Missing signer
    #[error("Missing signer")]
    MissingSigner,
    /// Missing Chain Parameter
    #[error("Missing chain parameter: {0}")]
    MissingChainParameter(String),
    /// Broadcast transaction error
    #[error("Broadcast transaction error: {0}")]
    BroadcastTransactionError(String),
    /// Reqwest error
    #[error("Reqwest error: {0}")]
    ReqwestError(#[from] reqwest::Error),
}

impl From<HyperlaneTronError> for ChainCommunicationError {
    fn from(value: HyperlaneTronError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
