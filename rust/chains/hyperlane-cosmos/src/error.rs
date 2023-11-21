use hyperlane_core::ChainCommunicationError;

/// Errors from the crates specific to the hyperlane-cosmos
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneCosmosError {
    /// bech32 error
    #[error("{0}")]
    Bech32(#[from] bech32::Error),
    /// gRPC error
    #[error("{0}")]
    GrpcError(#[from] tonic::Status),
    /// Cosmos error
    #[error("{0}")]
    CosmosError(#[from] cosmrs::Error),
    /// Cosmos error report
    #[error("{0}")]
    CosmosErrorReport(#[from] cosmrs::ErrorReport),
    /// Cosmwasm std error.
    #[error("{0}")]
    StdError(#[from] cosmwasm_std::StdError),
}

impl From<HyperlaneCosmosError> for ChainCommunicationError {
    fn from(value: HyperlaneCosmosError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
