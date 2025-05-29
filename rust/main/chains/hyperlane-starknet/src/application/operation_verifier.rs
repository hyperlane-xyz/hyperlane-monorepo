use async_trait::async_trait;
use derive_new::new;
use tracing::trace;

use hyperlane_core::HyperlaneMessage;
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};

const WARP_ROUTE_MARKER: &str = "/";

/// Application operation verifier for Starknet
#[derive(new)]
pub struct StarknetApplicationOperationVerifier {}

#[async_trait]
impl ApplicationOperationVerifier for StarknetApplicationOperationVerifier {
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        trace!(
            ?app_context,
            ?message,
            "Starknet application operation verifier",
        );

        Self::verify_message(app_context, message)
    }
}

impl StarknetApplicationOperationVerifier {
    fn verify_message(
        app_context: &Option<String>,
        _message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        let context = match app_context {
            Some(c) => c,
            None => return None,
        };

        if !context.contains(WARP_ROUTE_MARKER) {
            return None;
        }

        // Starting from this point we assume that we are in a warp route context
        None
    }
}
