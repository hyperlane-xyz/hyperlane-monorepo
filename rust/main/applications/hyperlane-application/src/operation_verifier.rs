use async_trait::async_trait;

use hyperlane_core::{HyperlaneMessage, U256};

/// Application operation verifier report
#[derive(Debug)]
pub enum ApplicationOperationVerifierReport {
    /// Amount below minimum (minimum, actual)
    AmountBelowMinimum(U256, U256),
    /// Message is malformed
    MalformedMessage(HyperlaneMessage),
    /// Zero amount
    ZeroAmount,
}

/// Trait to verify if operation is permitted for application
#[async_trait]
pub trait ApplicationOperationVerifier: Send + Sync {
    /// Verifies if message is permitted for application
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport>;
}
