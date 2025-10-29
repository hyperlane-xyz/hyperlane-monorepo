use async_trait::async_trait;
use derive_new::new;

use hyperlane_core::HyperlaneMessage;
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};

#[derive(new)]
pub struct KaspaApplicationOperationVerifier {}

#[async_trait]
impl ApplicationOperationVerifier for KaspaApplicationOperationVerifier {
    async fn verify(
        &self,
        _app_context: &Option<String>,
        _message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        return None;
    }
}
