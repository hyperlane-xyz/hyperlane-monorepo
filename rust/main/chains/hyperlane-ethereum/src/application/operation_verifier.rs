use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;
use tracing::debug;

use hyperlane_application::{ApplicationOperationVerifier, ApplicationOperationVerifierError};
use hyperlane_core::{Decode, HyperlaneMessage, H256};
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
    ) -> Result<(), ApplicationOperationVerifierError> {
        use ApplicationOperationVerifierError::{MalformedMessageError, UnknownApplicationError};

        debug!(
            ?app_context,
            ?message,
            "Ethereum application operation verifier",
        );

        let context = match app_context {
            None => return Ok(()),
            Some(c) => c,
        };

        if !context.contains(WARP_ROUTE_MARKER) {
            return Err(UnknownApplicationError(context.to_owned()));
        }

        // Starting from this point we assume that we are in a warp route context

        let mut reader = Cursor::new(message.body.as_slice());
        let token_message = TokenMessage::read_from(&mut reader)
            .map_err(|_| MalformedMessageError(message.clone()))?;

        let recipient = token_message.recipient();
        if Self::check_leading_zeros(&recipient) {
            return Err(MalformedMessageError(message.clone()));
        }

        Ok(())
    }
}

impl EthereumApplicationOperationVerifier {
    fn check_leading_zeros(address: &H256) -> bool {
        let zeros = &address.as_bytes()[0..ETHEREUM_ADDRESS_LEADING_ZEROS_COUNT];
        let count = zeros.iter().filter(|b| **b == 0).count();
        count == ETHEREUM_ADDRESS_LEADING_ZEROS_COUNT
    }
}
