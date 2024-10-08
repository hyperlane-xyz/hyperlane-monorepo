use cosmrs::proto::prost;
use hyperlane_core::ChainCommunicationError;
use std::fmt::Debug;

/// Errors from the crates specific to the hyperlane-cosmos
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneCosmosError {
    /// base64 error
    #[error("{0}")]
    Base64(#[from] base64::DecodeError),
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
    #[error("{0}")]
    /// Cosmrs Tendermint Error
    CosmrsTendermintError(#[from] cosmrs::tendermint::Error),
    #[error("{0}")]
    /// CosmWasm Error
    CosmWasmError(#[from] cosmwasm_std::StdError),
    /// Tonic error
    #[error("{0}")]
    Tonic(#[from] tonic::transport::Error),
    /// Tonic codegen error
    #[error("{0}")]
    TonicGenError(#[from] tonic::codegen::StdError),
    /// Tendermint RPC Error
    #[error(transparent)]
    TendermintError(#[from] tendermint_rpc::error::Error),
    /// Prost error
    #[error("{0}")]
    Prost(#[from] prost::DecodeError),
    /// Protobuf error
    #[error("{0}")]
    Protobuf(#[from] protobuf::ProtobufError),
    /// Fallback providers failed
    #[error("Fallback providers failed. (Errors: {0:?})")]
    FallbackProvidersFailed(Vec<HyperlaneCosmosError>),
}

impl From<HyperlaneCosmosError> for ChainCommunicationError {
    fn from(value: HyperlaneCosmosError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
