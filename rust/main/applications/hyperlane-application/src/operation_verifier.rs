use async_trait::async_trait;

use hyperlane_core::{ChainCommunicationError, HyperlaneMessage};

/// Error which can be reported by verifier
#[derive(Debug, thiserror::Error)]
pub enum ApplicationOperationVerifierError {
    /// Message is malformed
    #[error("Malformed message: {0:?}")]
    MalformedMessageError(HyperlaneMessage),
    /// Chain communication error
    #[error("Remote communication error: {0:?}")]
    ChainCommunicationError(ChainCommunicationError),
    /// Insufficient amount
    #[error("Insufficient amount")]
    InsufficientAmountError,
    /// Unknown application
    #[error("Unknown app context: {0:?}")]
    UnknownApplicationError(String),
}

/// Trait to verify if operation is permitted for application context
#[async_trait]
pub trait ApplicationOperationVerifier: Send + Sync {
    /// Checks if message is permitted for application context
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Result<(), ApplicationOperationVerifierError>;
}
