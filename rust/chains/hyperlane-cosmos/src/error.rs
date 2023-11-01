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
}

impl From<HyperlaneCosmosError> for ChainCommunicationError {
    fn from(value: HyperlaneCosmosError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
