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
    /// Cosmrs Tendermint Error
    #[error("{0}")]
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
    /// Cometbft Error
    #[error(transparent)]
    CometbftError(#[from] Box<cometbft::error::Error>),
    /// Cometbft RPC Error
    #[error(transparent)]
    CometbftRpcError(Box<cometbft_rpc::Error>),
    /// RPC transport errors whose dependency traces can contain credentials.
    #[error("{0}")]
    RpcTransportError(String),
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

impl From<cometbft_rpc::Error> for HyperlaneCosmosError {
    fn from(value: cometbft_rpc::Error) -> Self {
        Self::from(Box::new(value))
    }
}

impl From<Box<cometbft_rpc::Error>> for HyperlaneCosmosError {
    fn from(value: Box<cometbft_rpc::Error>) -> Self {
        use cometbft_rpc::error::ErrorDetail;

        // CometBFT erases reqwest errors into string traces, so without_url()
        // is no longer available here. Redact URLs while retaining the causes.
        match value.detail() {
            ErrorDetail::Http(_) | ErrorDetail::InvalidProxy(_) => {
                Self::RpcTransportError(redact_transport_urls(&value.to_string()))
            }
            ErrorDetail::InvalidUrl(_) => Self::RpcTransportError("Invalid HTTP RPC URL".into()),
            _ => Self::CometbftRpcError(value),
        }
    }
}

fn redact_transport_urls(message: &str) -> String {
    let mut redacted = String::with_capacity(message.len());
    // reqwest formats URLs using Url::Display, which percent-encodes whitespace.
    // Remove the entire URL-containing token: parsing punctuation delimiters
    // would leak suffixes of credentials containing parentheses or quotes.
    for token in message.split_inclusive(char::is_whitespace) {
        if token.contains("://") {
            redacted.push_str("<redacted-url>");
            redacted.push_str(&token[token.trim_end().len()..]);
        } else {
            redacted.push_str(token);
        }
    }
    redacted
}

impl From<cometbft::Error> for HyperlaneCosmosError {
    fn from(value: cometbft::Error) -> Self {
        HyperlaneCosmosError::CometbftError(Box::new(value))
    }
}

impl From<cosmrs::tendermint::Error> for HyperlaneCosmosError {
    fn from(value: cosmrs::tendermint::Error) -> Self {
        HyperlaneCosmosError::CosmrsTendermintError(Box::new(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_error_conversion_preserves_server_errors() {
        let error =
            HyperlaneCosmosError::from(cometbft_rpc::Error::server("server failure".into()));
        assert!(matches!(error, HyperlaneCosmosError::CometbftRpcError(_)));
        assert!(error.to_string().contains("server failure"));
        let error = HyperlaneCosmosError::from(cometbft_rpc::Error::http_request_failed(
            429u16.try_into().expect("HTTP status"),
        ));
        assert!(matches!(error, HyperlaneCosmosError::CometbftRpcError(_)));
        assert!(error.to_string().contains("429"));
    }

    #[test]
    fn transport_trace_preserves_causes_without_url_credentials() {
        for url in [
            "http://private-user:private-password@localhost/private-path?key=private-query",
            "https://localhost/private-)(query)?key=private-query%20with%20spaces",
            "http://[::1]/private-path?key=private-query",
        ] {
            let trace = format!("HTTP error\nCaused by:\n    error sending request for url ({url}): error trying to connect: tcp connect error: Connection refused (os error 61)");
            let redacted = redact_transport_urls(&trace);
            assert!(!redacted.contains("private-"));
            assert!(redacted.contains("HTTP error"));
            assert!(redacted.contains("<redacted-url>"));
            assert!(redacted.contains("tcp connect error: Connection refused (os error 61)"));
        }
        let trace = "request timed out: redirect from https://localhost/private-old to http://localhost/private-new\n";
        let redacted = redact_transport_urls(trace);
        assert_eq!(
            redacted,
            "request timed out: redirect from <redacted-url> to <redacted-url>\n"
        );
    }
}
