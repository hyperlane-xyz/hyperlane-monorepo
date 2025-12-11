use std::{ffi::FromBytesUntilNulError, str::Utf8Error};

use hyperlane_core::ChainCommunicationError;

/// Errors from the crates specific to the hyperlane-aleo
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneAleoError {
    /// Reqwest Errors
    #[error("{0}")]
    ReqwestError(#[from] reqwest::Error),
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
    /// Other errors
    #[error("{0}")]
    Other(String),
}

impl From<HyperlaneAleoError> for ChainCommunicationError {
    fn from(value: HyperlaneAleoError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
