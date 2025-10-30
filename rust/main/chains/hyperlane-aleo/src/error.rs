use hyperlane_core::ChainCommunicationError;

/// Errors from the crates specific to the hyperlane-radix
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
    /// Other errors
    #[error("{0}")]
    Other(String),
}

impl From<HyperlaneAleoError> for ChainCommunicationError {
    fn from(value: HyperlaneAleoError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}
