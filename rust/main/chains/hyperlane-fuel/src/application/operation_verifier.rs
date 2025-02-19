use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;

use hyperlane_core::{Decode, HyperlaneMessage, U256};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};
use hyperlane_warp_route::TokenMessage;

use tracing::trace;

const WARP_ROUTE_MARKER: &str = "/";

/// Application operation verifier for Cosmos
#[derive(new)]
pub struct FuelApplicationOperationVerifier {}

#[async_trait]
impl ApplicationOperationVerifier for FuelApplicationOperationVerifier {
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        trace!(
            ?app_context,
            ?message,
            "Fuel application operation verifier",
        );

        Self::verify_message(app_context, message)
    }
}

impl FuelApplicationOperationVerifier {
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
