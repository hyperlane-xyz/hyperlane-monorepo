use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;
use tracing::trace;

use hyperlane_core::{Decode, HyperlaneMessage, HyperlaneProvider, U256};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};
use hyperlane_warp_route::TokenMessage;

#[derive(new)]
/// Kaspa application operation verifier
pub struct KaspaApplicationOperationVerifier {}

#[async_trait]
impl ApplicationOperationVerifier for KaspaApplicationOperationVerifier {
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        return None;
    }
}
