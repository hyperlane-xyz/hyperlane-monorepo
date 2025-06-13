use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;
use tracing::trace;

use hyperlane_core::{Decode, HyperlaneMessage, HyperlaneProvider, U256};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};
use hyperlane_warp_route::TokenMessage;

const WARP_ROUTE_MARKER: &str = "/";

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
        trace!(
            ?app_context,
            ?message,
            "Kaspa application operation verifier",
        );

        Self::verify_message(app_context, message)
    }
}

impl KaspaApplicationOperationVerifier {
    fn verify_message(
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        use ApplicationOperationVerifierReport::{MalformedMessage, ZeroAmount};

        let context = match app_context {
            Some(c) => c,
            None => return None,
        };

        if !context.contains(WARP_ROUTE_MARKER) {
            return None;
        }

        // Starting from this point we assume that we are in a warp route context

        let mut reader = Cursor::new(message.body.as_slice());
        let token_message = match TokenMessage::read_from(&mut reader) {
            Ok(m) => m,
            Err(_) => return Some(MalformedMessage(message.clone())),
        };

        if token_message.amount() == U256::zero() {
            return Some(ZeroAmount);
        }

        None
    }
}

#[cfg(test)]
mod tests;
