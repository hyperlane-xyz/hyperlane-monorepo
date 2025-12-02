use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;
use tracing::trace;

use hyperlane_core::{Decode, HyperlaneMessage, H256};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};
use hyperlane_warp_route::TokenMessage;

const WARP_ROUTE_MARKER: &str = "/";
const ETHEREUM_ADDRESS_LEADING_ZEROS_COUNT: usize = 12;

/// Application context verifier for Ethereum
#[derive(new)]
pub struct EthereumApplicationOperationVerifier {}

#[async_trait]
impl ApplicationOperationVerifier for EthereumApplicationOperationVerifier {
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        trace!(
            ?app_context,
            ?message,
            "Ethereum application operation verifier",
        );

        Self::verify_message(app_context, message)
    }
}

impl EthereumApplicationOperationVerifier {
    fn verify_message(
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        use ApplicationOperationVerifierReport::MalformedMessage;

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

        let recipient = token_message.recipient();
        if !Self::has_enough_leading_zeroes(&recipient) {
            return Some(MalformedMessage(message.clone()));
        }

        None
    }

    fn has_enough_leading_zeroes(address: &H256) -> bool {
        let zeros = &address.as_bytes()[0..ETHEREUM_ADDRESS_LEADING_ZEROS_COUNT];
        let count = zeros.iter().filter(|b| **b == 0).count();
        count == ETHEREUM_ADDRESS_LEADING_ZEROS_COUNT
    }
}

#[cfg(test)]
mod tests;
