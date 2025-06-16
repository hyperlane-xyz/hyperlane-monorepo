use std::fmt::Debug;

use cosmrs::proto::prost;
use crypto::PublicKeyError;

use hyperlane_core::ChainCommunicationError;

/// Errors from the crates specific to the hyperlane-kaspa
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneKaspaError {
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
    GrpcError(#[from] tonic::Status),
    /// Kaspa error
    #[error("{0}")]
    HyperlaneKaspaError(#[from] cosmrs::Error),
    /// Kaspa error report
    #[error("{0}")]
    KaspaErrorReport(#[from] cosmrs::ErrorReport),
    /// Cosmrs Tendermint Error
    #[error("{0}")]
    CosmrsTendermintError(#[from] cosmrs::tendermint::Error),
    /// Tonic error
    #[error("{0}")]
    Tonic(#[from] tonic::transport::Error),
    /// Tonic codegen error
    #[error("{0}")]
    TonicGenError(#[from] tonic::codegen::StdError),
    /// Tendermint RPC Error
    #[error(transparent)]
    TendermintRpcError(#[from] tendermint_rpc::error::Error),
    /// Prost error
    #[error("{0}")]
    Prost(#[from] prost::DecodeError),
    /// Protobuf error
    #[error("{0}")]
    Protobuf(#[from] protobuf::ProtobufError),
    /// Fallback providers failed
    #[error("Fallback providers failed. (Errors: {0:?})")]
    FallbackProvidersFailed(Vec<HyperlaneKaspaError>),
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
    ParsingAttemptsFailed(Vec<HyperlaneKaspaError>),
}

impl From<HyperlaneKaspaError> for ChainCommunicationError {
    fn from(value: HyperlaneKaspaError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}

impl From<PublicKeyError> for HyperlaneKaspaError {
    fn from(value: PublicKeyError) -> Self {
        HyperlaneKaspaError::PublicKeyError(value.to_string())
    }
}
