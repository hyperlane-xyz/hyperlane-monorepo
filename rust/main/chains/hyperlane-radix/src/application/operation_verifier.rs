use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;
use scrypto::math::Decimal;
use tracing::trace;

use hyperlane_core::{Decode, HyperlaneMessage};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};
use hyperlane_warp_route::TokenMessage;
use ApplicationOperationVerifierReport::MalformedMessage;

use crate::decimal_to_u256;

const WARP_ROUTE_MARKER: &str = "/";

/// Application operation verifier for Radix
#[derive(new)]
pub struct RadixApplicationOperationVerifier {}

#[async_trait]
impl ApplicationOperationVerifier for RadixApplicationOperationVerifier {
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        trace!(
            ?app_context,
            ?message,
            "Radix application operation verifier",
        );

        Self::verify_message(app_context, message)
    }
}

impl RadixApplicationOperationVerifier {
    fn verify_message(
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
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

        if token_message.amount() > decimal_to_u256(Decimal::MAX) {
            return Some(MalformedMessage(message.clone()));
        }

        None
    }
}

#[cfg(test)]
mod test {
    use std::ops::Add;

    use super::*;
    use hyperlane_core::Encode;
    use hyperlane_core::H256;

    fn encode(token_message: TokenMessage) -> Vec<u8> {
        let mut encoded = vec![];
        token_message.write_to(&mut encoded).unwrap();
        encoded
    }

    #[test]
    fn test_amount_not_too_big() {
        let app_context = Some("H/warp-route".to_string());
        let amount = decimal_to_u256(Decimal::MAX);

        let token_message = TokenMessage::new(H256::zero(), amount, vec![]);
        let encoded = encode(token_message);
        let message = HyperlaneMessage {
            body: encoded,
            ..Default::default()
        };

        // when
        let report = RadixApplicationOperationVerifier::verify_message(&app_context, &message);

        // then
        assert_eq!(report, None);
    }

    #[test]
    fn test_amount_too_big() {
        let app_context = Some("H/warp-route".to_string());

        let amount = decimal_to_u256(Decimal::MAX).add(1);

        let token_message = TokenMessage::new(H256::zero(), amount, vec![]);
        let encoded = encode(token_message);
        let message = HyperlaneMessage {
            body: encoded,
            ..Default::default()
        };

        // when
        let report = RadixApplicationOperationVerifier::verify_message(&app_context, &message);

        // then
        assert_eq!(report.unwrap(), MalformedMessage(message));
    }
}
