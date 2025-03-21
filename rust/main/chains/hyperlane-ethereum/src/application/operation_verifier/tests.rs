use hyperlane_core::{Encode, HyperlaneMessage, H256, U256};
use hyperlane_operation_verifier::ApplicationOperationVerifierReport::MalformedMessage;
use hyperlane_warp_route::TokenMessage;

use crate::application::EthereumApplicationOperationVerifier;

#[test]
fn test_app_context_empty() {
    // given
    let app_context = None;
    let message = HyperlaneMessage::default();

    // when
    let report = EthereumApplicationOperationVerifier::verify_message(&app_context, &message);

    // then
    assert!(report.is_none());
}

#[test]
fn test_app_context_not_warp_route() {
    // given
    let app_context = Some("not-warp-route".to_string());
    let message = HyperlaneMessage::default();

    // when
    let report = EthereumApplicationOperationVerifier::verify_message(&app_context, &message);

    // then
    assert!(report.is_none());
}

#[test]
fn test_message_is_not_token_message() {
    // given
    let app_context = Some("H/warp-route".to_string());
    let message = HyperlaneMessage::default();

    // when
    let report = EthereumApplicationOperationVerifier::verify_message(&app_context, &message);

    // then
    assert_eq!(report.unwrap(), MalformedMessage(message));
}

#[test]
fn test_token_message_address_not_enough_zeros() {
    // given
    let app_context = Some("H/warp-route".to_string());
    let address = address_not_enough_zeros();
    let token_message = TokenMessage::new(address, U256::one(), vec![]);
    let encoded = encode(token_message);
    let message = HyperlaneMessage {
        body: encoded,
        ..Default::default()
    };

    // when
    let report = EthereumApplicationOperationVerifier::verify_message(&app_context, &message);

    // then
    assert_eq!(report.unwrap(), MalformedMessage(message));
}

#[test]
fn test_token_message_address_enough_zeros() {
    // given
    let app_context = Some("H/warp-route".to_string());
    let token_message = TokenMessage::new(H256::zero(), U256::one(), vec![]);
    let encoded = encode(token_message);
    let message = HyperlaneMessage {
        body: encoded,
        ..Default::default()
    };

    // when
    let report = EthereumApplicationOperationVerifier::verify_message(&app_context, &message);

    // then
    assert!(report.is_none());
}

#[test]
fn test_address_not_enough_zeros() {
    // given
    let address = address_not_enough_zeros();

    // when
    let has = EthereumApplicationOperationVerifier::has_enough_leading_zeroes(&address);

    // then
    assert!(!has);
}

#[test]
fn test_address_enough_zeros() {
    // given
    let address = H256::zero();

    // when
    let has = EthereumApplicationOperationVerifier::has_enough_leading_zeroes(&address);

    // then
    assert!(has);
}

fn encode(token_message: TokenMessage) -> Vec<u8> {
    let mut encoded = vec![];
    token_message.write_to(&mut encoded).unwrap();
    encoded
}

fn address_not_enough_zeros() -> H256 {
    let mut buf = vec![0; 32];
    buf.fill(255);

    H256::from_slice(&buf)
}
