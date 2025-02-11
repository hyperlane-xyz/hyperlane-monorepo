use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;
use tracing::debug;

use hyperlane_core::{Decode, HyperlaneMessage, U256};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};
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
    ) -> Option<ApplicationOperationVerifierReport> {
        use ApplicationOperationVerifierReport::{AmountBelowMinimum, MalformedMessage};

        debug!(
            ?app_context,
            ?message,
            "Sealevel application operation verifier",
        );

        let context = match app_context {
            Some(c) => c,
            None => return None,
        };

        if !context.starts_with(WARP_ROUTE_PREFIX) {
            return None;
        }

        // Starting from this point we assume that we are in a warp route context

        let mut reader = Cursor::new(message.body.as_slice());
        let token_message = match TokenMessage::read_from(&mut reader) {
            Ok(m) => m,
            Err(_) => return Some(MalformedMessage(message.clone())),
        };

        let minimum: U256 = match self
            .provider
            .rpc()
            // We assume that account will contain no data
            .get_minimum_balance_for_rent_exemption(0)
            .await
        {
            Ok(m) => m.into(),
            Err(_) => return None,
        };

        if token_message.amount() < minimum {
            return Some(AmountBelowMinimum(minimum, token_message.amount()));
        }

        None
    }
}
