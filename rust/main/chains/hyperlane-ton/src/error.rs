use hyperlane_core::ChainCommunicationError;
use thiserror::Error;

/// Errors specific to the Hyperlane-TON implementation.
#[derive(Debug, Error)]
pub enum HyperlaneTonError {
    #[error("No account found for the provided address: {0}")]
    AccountNotFound(String),
    /// Toncenter API connection error
    #[error("Failed to connect to Toncenter API: {0}")]
    ApiConnectionError(String),
    /// Invalid response from Toncenter API
    #[error("Invalid response from Toncenter API: {0}")]
    ApiInvalidResponse(String),
    /// Timeout while waiting for API response
    #[error("API response timeout")]
    ApiTimeout,
    /// Error related to API rate limits
    #[error("Rate limit exceeded for Toncenter API")]
    ApiRateLimitExceeded,
    #[error("API request failed")]
    ApiRequestFailed(String),
    #[error("Conversion data failed")]
    ConversionFailed(String),
    #[error("Failed to parse stack item: {0}")]
    FailedToParseStackItem(String),
    #[error("Failed to build cell: {0}")]
    FailedBuildingCell(String),
    #[error("Reqwest error: {0}")]
    ReqwestError(#[from] reqwest::Error),
    /// Error while making a call to a smart contract
    #[error("Contract call failed: {0}")]
    ContractCallError(String),
    /// Insufficient gas
    #[error("Insufficient gas for transaction")]
    InsufficientGas,
    /// Insufficient funds
    #[error("Insufficient funds. Required: {required:?}, available: {available:?}")]
    InsufficientFunds { required: u64, available: u64 },
    /// Data parsing error
    #[error("Data parsing error: {0}")]
    ParsingError(String),
    #[error("Failed to construct URL: {0}")]
    UrlConstructionError(String),
    #[error("Unknown module type value: {0}")]
    UnknownModuleType(u32),
    #[error("No transaction found for the provided hash")]
    TransactionNotFound,
    /// Invalid configuration
    #[error("Invalid configuration: {0}")]
    InvalidConfiguration(String),
    #[error("No blocks found in the response")]
    NoBlocksFound,
    /// Unknown error
    #[error("Unknown error: {0}")]
    UnknownError(String),
    #[error("Timeout request")]
    Timeout,
    #[error("Ton message error")]
    TonMessageError(String),
}

impl From<HyperlaneTonError> for ChainCommunicationError {
    fn from(value: HyperlaneTonError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
