use hyperlane_core::{Encode, HyperlaneMessage, H256, U256};
use hyperlane_operation_verifier::ApplicationOperationVerifierReport::{
    MalformedMessage, ZeroAmount,
};
use hyperlane_warp_route::TokenMessage;

use crate::application::KaspaApplicationOperationVerifier;

#[test]
fn test_app_context_empty() {
    // given
    let app_context = None;
    let message = HyperlaneMessage::default();

    // when
    let report = KaspaApplicationOperationVerifier::verify_message(&app_context, &message);

    // then
    assert!(report.is_none());
}

#[test]
fn test_app_context_not_warp_route() {
    // given
    let app_context = Some("not-warp-route".to_string());
    let message = HyperlaneMessage::default();

    // when
    let report = KaspaApplicationOperationVerifier::verify_message(&app_context, &message);

    // then
    assert!(report.is_none());
}

#[test]
fn test_message_is_not_token_message() {
    // given
    let app_context = Some("H/warp-route".to_string());
    let message = HyperlaneMessage::default();

    // when
    let report = KaspaApplicationOperationVerifier::verify_message(&app_context, &message);

    // then
    assert_eq!(report.unwrap(), MalformedMessage(message));
}

#[test]
fn test_token_message_with_zero_amount() {
    // given
    let app_context = Some("H/warp-route".to_string());
    let token_message = TokenMessage::new(H256::zero(), U256::zero(), vec![]);
    let encoded = encode(token_message);
    let message = HyperlaneMessage {
        body: encoded,
        ..Default::default()
    };

    // when
    let report = KaspaApplicationOperationVerifier::verify_message(&app_context, &message);

    // then
    assert_eq!(report.unwrap(), ZeroAmount);
}

#[test]
fn test_token_message_with_positive_amount() {
    // given
    let app_context = Some("H/warp-route".to_string());
    let token_message = TokenMessage::new(H256::zero(), U256::one(), vec![]);
    let encoded = encode(token_message);
    let message = HyperlaneMessage {
        body: encoded,
        ..Default::default()
    };

    // when
    let report = KaspaApplicationOperationVerifier::verify_message(&app_context, &message);

    // then
    assert!(report.is_none());
}

fn encode(token_message: TokenMessage) -> Vec<u8> {
    let mut encoded = vec![];
    token_message.write_to(&mut encoded).unwrap();
    encoded
}
