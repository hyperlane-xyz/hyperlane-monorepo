use hyperlane_core::ChainCommunicationError;

/// Errors from the crates specific to the hyperlane-tron
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneTronError {
    /// HTTP API response error
    #[error("HTTP response error: status={status}, body={body}")]
    HttpResponseError {
        /// HTTP status code
        status: u16,
        /// Response body
        body: String,
    },
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
    ReqwestError(#[source] reqwest::Error),
    /// JSON deserialization error
    #[error("JSON deserialization error: {0}")]
    JsonError(#[from] serde_json::Error),
    /// Signing error
    #[error("Signing error: {0}")]
    SigningError(#[from] crate::signer::TronSignersError),
}

impl From<reqwest::Error> for HyperlaneTronError {
    fn from(error: reqwest::Error) -> Self {
        Self::ReqwestError(error.without_url())
    }
}

impl From<HyperlaneTronError> for ChainCommunicationError {
    fn from(value: HyperlaneTronError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn http_errors_omit_endpoint_credentials() {
        let url = reqwest::Url::parse("http://localhost/private-path?key=private-query").unwrap();
        let error = reqwest::Client::new()
            .get(url.clone())
            .header("invalid\nheader", "value")
            .build()
            .unwrap_err()
            .with_url(url);
        let error = HyperlaneTronError::from(error);
        assert!(!format!("{error:?} {error}").contains("private-"));
        let HyperlaneTronError::ReqwestError(error) = error else {
            panic!("expected HTTP error");
        };
        assert!(error.url().is_none());
        assert!(error.is_builder());
    }
}
