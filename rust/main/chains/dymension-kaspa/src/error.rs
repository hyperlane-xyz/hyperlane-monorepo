use std::fmt::Debug;

use cosmrs::proto::prost;
use crypto::PublicKeyError;

use hyperlane_core::ChainCommunicationError;

#[derive(Debug, thiserror::Error)]
pub enum HyperlaneKaspaError {
    #[error("{0}")]
    Base64(#[from] base64::DecodeError),
    #[error("{0}")]
    Bech32Decode(#[from] bech32::DecodeError),
    #[error("{0}")]
    Bech32Encode(#[from] bech32::EncodeError),
    #[error("{0}")]
    GrpcError(#[from] tonic::Status),
    #[error("{0}")]
    HyperlaneKaspaError(#[from] cosmrs::Error),
    #[error("{0}")]
    KaspaErrorReport(#[from] cosmrs::ErrorReport),
    #[error("{0}")]
    CosmrsTendermintError(#[from] cosmrs::tendermint::Error),
    #[error("{0}")]
    Tonic(#[from] tonic::transport::Error),
    #[error("{0}")]
    TonicGenError(#[from] tonic::codegen::StdError),
    #[error(transparent)]
    TendermintRpcError(#[from] tendermint_rpc::error::Error),
    #[error("{0}")]
    Prost(#[from] prost::DecodeError),
    #[error("Fallback providers failed. (Errors: {0:?})")]
    FallbackProvidersFailed(Vec<HyperlaneKaspaError>),
    #[error("{0}")]
    PublicKeyError(String),
    #[error("{0}")]
    AddressError(String),
    #[error("{0}")]
    SignerInfoError(String),
    #[error("{0}")]
    SerdeError(#[from] serde_json::Error),
    #[error("{0}")]
    UnparsableEmptyField(String),
    #[error("{0}")]
    ParsingFailed(String),
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
