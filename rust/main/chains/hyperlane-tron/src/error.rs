use hyperlane_core::ChainCommunicationError;

/// Errors from the crates specific to the hyperlane-ethereum
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneTronError {
    /// gRPC error
    #[error("{0}")]
    GrpcError(#[from] Box<tonic::Status>),
    /// Tonic error
    #[error("{0}")]
    Tonic(#[from] tonic::transport::Error),
    /// Tonic codegen error
    #[error("{0}")]
    TonicGenError(#[from] tonic::codegen::StdError),
    /// Missing raw data
    #[error("Missing raw data")]
    MissingRawData,
    /// Missing block header
    #[error("Missing block header")]
    MissingBlockHeader,
    /// Missing transaction raw data in response
    #[error("Missing transaction raw data")]
    MissingTransactionRawData,
    /// Protobuf encoding/decoding error
    #[error("Protobuf error: {0}")]
    ProtobufError(#[from] prost::EncodeError),
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

impl From<tonic::Status> for HyperlaneTronError {
    fn from(value: tonic::Status) -> Self {
        HyperlaneTronError::GrpcError(Box::new(value))
    }
}

impl From<HyperlaneTronError> for ChainCommunicationError {
    fn from(value: HyperlaneTronError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
