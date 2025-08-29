use {
    async_trait::async_trait,
    hyperlane_core::HyperlaneMessage,
    hyperlane_operation_verifier::{
        ApplicationOperationVerifier, ApplicationOperationVerifierReport,
    },
};

#[derive(Default)]
pub struct DangoApplicationOperationVerifier {}

#[async_trait]
impl ApplicationOperationVerifier for DangoApplicationOperationVerifier {
    async fn verify(
        &self,
        _app_context: &Option<String>,
        _message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        // Not mandatory to implement.
        None
    }
}
