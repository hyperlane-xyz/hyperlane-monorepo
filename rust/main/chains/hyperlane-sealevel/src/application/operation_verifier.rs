use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;
use tracing::debug;

use hyperlane_application::{ApplicationOperationVerifier, ApplicationOperationVerifierError};
use hyperlane_core::{Decode, HyperlaneMessage, U256};
use hyperlane_warp_route::TokenMessage;

use crate::SealevelProvider;

const WARP_ROUTE_PREFIX: &str = "SOL/";

/// Application operation verifier for Sealevel
#[derive(new)]
pub struct SealevelApplicationOperationVerifier {
    provider: SealevelProvider,
}

#[async_trait]
impl ApplicationOperationVerifier for SealevelApplicationOperationVerifier {
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Result<(), ApplicationOperationVerifierError> {
        use ApplicationOperationVerifierError::*;

        debug!(
            ?app_context,
            ?message,
            "Sealevel application operation verifier",
        );

        let context = match app_context {
            None => return Ok(()),
            Some(c) => c,
        };

        if !context.starts_with(WARP_ROUTE_PREFIX) {
            return Err(UnknownApplicationError(context.to_owned()));
        }

        // Starting from this point we assume that we are in a warp route context

        let mut reader = Cursor::new(message.body.as_slice());
        let token_message = TokenMessage::read_from(&mut reader)
            .map_err(|_| MalformedMessageError(message.clone()))?;

        let minimum: U256 = self
            .provider
            .rpc()
            // We assume that account will contain no data
            .get_minimum_balance_for_rent_exemption(0)
            .await
            .map_err(ChainCommunicationError)?
            .into();

        if token_message.amount() < minimum {
            return Err(InsufficientAmountError);
        }

        Ok(())
    }
}
