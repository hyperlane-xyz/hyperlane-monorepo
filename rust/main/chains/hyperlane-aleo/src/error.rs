use std::{ffi::FromBytesUntilNulError, str::Utf8Error};

use hyperlane_core::ChainCommunicationError;

/// HTTP status error returned while authenticating with a delegated prover.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct DelegatedProverAuthError(#[source] reqwest::Error);

impl DelegatedProverAuthError {
    pub(crate) fn new(error: reqwest::Error) -> Self {
        Self(error.without_url())
    }
}

/// Errors from the crates specific to the hyperlane-aleo
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneAleoError {
    /// Reqwest Errors
    #[error("{0}")]
    ReqwestError(#[source] reqwest::Error),
    /// HTTP status errors from delegated prover authentication.
    #[error("{0}")]
    DelegatedProverAuth(#[from] DelegatedProverAuthError),
    /// Anyhow Errors
    #[error("{0}")]
    SnarkVmError(#[from] anyhow::Error),
    /// Serde Errors
    #[error("{0}")]
    SerdeError(#[from] serde_json::Error),
    /// Signer missing
    #[error("Signer missing")]
    SignerMissing,
    /// Utf8 error
    #[error("{0}")]
    Utf8Error(#[from] Utf8Error),
    /// C String parsing error
    #[error("{0}")]
    CStringParsing(#[from] FromBytesUntilNulError),
    /// Unknown Network
    #[error("Unknown Network with ID: {0}")]
    UnknownNetwork(u16),
    /// Unknown ISM
    #[error("Unknown ISM: {0}")]
    UnknownIsm(String),
    /// Missing Route
    #[error("Missing Route: {routing_ism} from origin {origin}")]
    RoutingIsmMissingRoute {
        /// The route key
        routing_ism: String,
        /// Origin domain
        origin: u32,
    },
    /// Mailbox uninitialized
    #[error("Mailbox uninitialized")]
    MailboxUninitialized,
    /// App uninitialized
    #[error("App uninitialized")]
    AppUninitialized,
    /// Unknown Merkle Tree Hook
    #[error("Unknown Merkle Tree Hook: {0}")]
    UnknownMerkleTreeHook(String),
    /// TryFromSliceError
    #[error("{0}")]
    TryFromSliceError(#[from] std::array::TryFromSliceError),
    /// Missing Auth Header
    #[error("Missing Auth Header")]
    MissingAuthHeader,
    /// Malicious Program Detected
    #[error("Malicious Program Detected: program_id={program_id}, transition={transition}")]
    MaliciousProgramDetected {
        /// Program ID
        program_id: String,
        /// Transition
        transition: String,
    },
    /// Other errors
    #[error("{0}")]
    Other(String),
}

impl From<reqwest::Error> for HyperlaneAleoError {
    fn from(error: reqwest::Error) -> Self {
        Self::ReqwestError(error.without_url())
    }
}

impl From<HyperlaneAleoError> for ChainCommunicationError {
    fn from(value: HyperlaneAleoError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn http_errors_omit_endpoint_credentials() {
        let request_error = || {
            let url =
                reqwest::Url::parse("http://localhost/private-path?key=private-query").unwrap();
            reqwest::Client::new()
                .get(url.clone())
                .header("invalid\nheader", "value")
                .build()
                .unwrap_err()
                .with_url(url)
        };
        let error = HyperlaneAleoError::from(request_error());
        assert!(!format!("{error:?} {error}").contains("private-"));
        let HyperlaneAleoError::ReqwestError(error) = error else {
            panic!("expected HTTP error");
        };
        assert!(error.url().is_none());
        assert!(error.is_builder());
        let error = DelegatedProverAuthError::new(request_error());
        assert!(!format!("{error:?} {error}").contains("private-"));
        assert!(error.0.url().is_none());
    }
}
