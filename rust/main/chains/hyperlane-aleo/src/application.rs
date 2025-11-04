use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;
use tracing::trace;

use hyperlane_core::{Decode, HyperlaneMessage, U128};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};
use hyperlane_warp_route::TokenMessage;

const WARP_ROUTE_MARKER: &str = "/";

/// Application operation verifier for Aleo
#[derive(new)]
pub struct AleoApplicationOperationVerifier {}

#[async_trait]
impl ApplicationOperationVerifier for AleoApplicationOperationVerifier {
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        trace!(
            ?app_context,
            ?message,
            "Aleo application operation verifier",
        );

        Self::verify_message(app_context, message)
    }
}

impl AleoApplicationOperationVerifier {
    fn verify_message(
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        use ApplicationOperationVerifierReport::{MalformedMessage, ZeroAmount};

        // Aleo only supprts messages up to 128 bytes
        // Aleo only supports messages bodies that are a multiple of 8 bytes
        let body_bytes = message.body.len();
        if body_bytes % 8 != 0 || body_bytes > 128 {
            return Some(MalformedMessage(message.clone()));
        }

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

        // Max amount is u128 for token transfers
        if token_message.amount() > U128::max_value().into() {
            return Some(ZeroAmount);
        }

        None
    }
}
