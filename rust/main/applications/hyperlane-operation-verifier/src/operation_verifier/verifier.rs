use async_trait::async_trait;

use hyperlane_core::HyperlaneMessage;

use crate::ApplicationOperationVerifierReport;

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
