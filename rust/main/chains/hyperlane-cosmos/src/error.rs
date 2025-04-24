use std::fmt::Debug;

use cosmrs::proto::prost;

use crypto::PublicKeyError;
use hyperlane_core::ChainCommunicationError;

/// Errors from the crates specific to the hyperlane-cosmos
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneCosmosError {
    /// base64 error
    #[error("{0}")]
    Base64(#[from] base64::DecodeError),
    /// bech32 decode error
    #[error("{0}")]
    Bech32Decode(#[from] bech32::DecodeError),
    /// bech32 encode error
    #[error("{0}")]
    Bech32Encode(#[from] bech32::EncodeError),
    /// gRPC error
    #[error("{0}")]
    GrpcError(#[from] Box<tonic::Status>),
    /// Cosmos error
    #[error("{0}")]
    CosmosError(#[from] Box<cosmrs::Error>),
    /// Cosmos error report
    #[error("{0}")]
    CosmosErrorReport(#[from] Box<cosmrs::ErrorReport>),
    #[error("{0}")]
    /// Cosmrs Tendermint Error
    CosmrsTendermintError(#[from] Box<cosmrs::tendermint::Error>),
    #[error("{0}")]
    /// CosmWasm Error
    CosmWasmError(#[from] Box<cosmwasm_std::StdError>),
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
    /// Public key error
    #[error("{0}")]
    PublicKeyError(String),
    /// Address error
    #[error("{0}")]
    AddressError(String),
    /// Signer info error
    #[error("{0}")]
    SignerInfoError(String),
    /// Serde error
    #[error("{0}")]
    SerdeError(#[from] serde_json::Error),
    /// Empty error
    #[error("{0}")]
    UnparsableEmptyField(String),
    /// Parsing error
    #[error("{0}")]
    ParsingFailed(String),
    /// Parsing attempt failed
    #[error("Parsing attempt failed. (Errors: {0:?})")]
    ParsingAttemptsFailed(Vec<HyperlaneCosmosError>),
}

impl From<cosmrs::ErrorReport> for HyperlaneCosmosError {
    fn from(value: cosmrs::ErrorReport) -> Self {
        HyperlaneCosmosError::CosmosErrorReport(Box::new(value))
    }
}

impl From<tonic::Status> for HyperlaneCosmosError {
    fn from(value: tonic::Status) -> Self {
        HyperlaneCosmosError::GrpcError(Box::new(value))
    }
}

impl From<cosmrs::Error> for HyperlaneCosmosError {
    fn from(value: cosmrs::Error) -> Self {
        HyperlaneCosmosError::CosmosError(Box::new(value))
    }
}

impl From<cosmrs::tendermint::Error> for HyperlaneCosmosError {
    fn from(value: cosmrs::tendermint::Error) -> Self {
        HyperlaneCosmosError::CosmrsTendermintError(Box::new(value))
    }
}

impl From<cosmwasm_std::StdError> for HyperlaneCosmosError {
    fn from(value: cosmwasm_std::StdError) -> Self {
        HyperlaneCosmosError::CosmWasmError(Box::new(value))
    }
}

impl From<HyperlaneCosmosError> for ChainCommunicationError {
    fn from(value: HyperlaneCosmosError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}

impl From<PublicKeyError> for HyperlaneCosmosError {
    fn from(value: PublicKeyError) -> Self {
        HyperlaneCosmosError::PublicKeyError(value.to_string())
    }
}
