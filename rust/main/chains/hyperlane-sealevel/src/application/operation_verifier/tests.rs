use hyperlane_core::{utils::hex_or_base58_to_h256, Encode, HyperlaneMessage, H256, U256};
use hyperlane_operation_verifier::ApplicationOperationVerifierReport::{
    AmountBelowMinimum, MalformedMessage,
};
use hyperlane_warp_route::TokenMessage;

use crate::application::SealevelApplicationOperationVerifier;

#[tokio::test]
async fn test_app_context_empty() {
    // given
    let app_context = None;
    let message = HyperlaneMessage::default();
    let check_account_does_not_exist_and_get_minimum = |_: H256| async move { None };

    // when
    let report = SealevelApplicationOperationVerifier::verify_message(
        &app_context,
        &message,
        check_account_does_not_exist_and_get_minimum,
    )
    .await;

    // then
    assert!(report.is_none());
}

#[tokio::test]
async fn test_app_context_not_warp_route() {
    // given
    let app_context = Some("not-warp-route".to_string());
    let message = HyperlaneMessage::default();
    let check_account_does_not_exist_and_get_minimum = |_: H256| async move { None };

    // when
    let report = SealevelApplicationOperationVerifier::verify_message(
        &app_context,
        &message,
        check_account_does_not_exist_and_get_minimum,
    )
    .await;

    // then
    assert!(report.is_none());
}

#[tokio::test]
async fn test_app_context_not_native_warp_route() {
    // given
    let app_context = Some("NOT_NATIVE/warp-route".to_string());
    let message = HyperlaneMessage::default();
    let check_account_does_not_exist_and_get_minimum = |_: H256| async move { None };

    // when
    let report = SealevelApplicationOperationVerifier::verify_message(
        &app_context,
        &message,
        check_account_does_not_exist_and_get_minimum,
    )
    .await;

    // then
    assert!(report.is_none());
}

#[tokio::test]
async fn test_message_not_native_warp_route_recipient() {
    // given
    let app_context = Some("SOL/warp-route".to_string());
    let message = HyperlaneMessage {
        recipient: hex_or_base58_to_h256("5dDyfdy9fannAdHEkYghgQpiPZrQPHadxBLa1WsGHPFi").unwrap(),
        ..Default::default()
    };
    let check_account_does_not_exist_and_get_minimum = |_: H256| async move { None };

    // when
    let report = SealevelApplicationOperationVerifier::verify_message(
        &app_context,
        &message,
        check_account_does_not_exist_and_get_minimum,
    )
    .await;

    // then
    assert!(report.is_none());
}

#[tokio::test]
async fn test_message_is_not_token_message() {
    // given
    let app_context = Some("SOL/warp-route".to_string());
    let message = HyperlaneMessage {
        recipient: hex_or_base58_to_h256("8DtAGQpcMuD5sG3KdxDy49ydqXUggR1LQtebh2TECbAc").unwrap(),
        ..Default::default()
    };
    let check_account_does_not_exist_and_get_minimum = |_: H256| async move { None };

    // when
    let report = SealevelApplicationOperationVerifier::verify_message(
        &app_context,
        &message,
        check_account_does_not_exist_and_get_minimum,
    )
    .await;

    // then
    assert_eq!(report.unwrap(), MalformedMessage(message));
}

#[tokio::test]
async fn test_token_recipient_exists_or_communication_error() {
    // given
    let app_context = Some("SOL/warp-route".to_string());
    let token_message = TokenMessage::new(H256::zero(), U256::one(), vec![]);
    let message = HyperlaneMessage {
        recipient: hex_or_base58_to_h256("8DtAGQpcMuD5sG3KdxDy49ydqXUggR1LQtebh2TECbAc").unwrap(),
        body: encode(token_message),
        ..Default::default()
    };
    let check_account_does_not_exist_and_get_minimum = |_: H256| async move { None };

    // when
    let report = SealevelApplicationOperationVerifier::verify_message(
        &app_context,
        &message,
        check_account_does_not_exist_and_get_minimum,
    )
    .await;

    // then
    assert!(report.is_none());
}

#[tokio::test]
async fn test_below_minimum() {
    // given
    let app_context = Some("SOL/warp-route".to_string());
    let amount = U256::one();
    let minimum = U256::one() * 2;
    let token_message = TokenMessage::new(H256::zero(), amount, vec![]);
    let message = HyperlaneMessage {
        recipient: hex_or_base58_to_h256("8DtAGQpcMuD5sG3KdxDy49ydqXUggR1LQtebh2TECbAc").unwrap(),
        body: encode(token_message),
        ..Default::default()
    };
    let check_account_does_not_exist_and_get_minimum = |_: H256| async move { Some(minimum) };

    // when
    let report = SealevelApplicationOperationVerifier::verify_message(
        &app_context,
        &message,
        check_account_does_not_exist_and_get_minimum,
    )
    .await;

    // then
    assert_eq!(
        report.unwrap(),
        AmountBelowMinimum {
            minimum,
            actual: amount,
        }
    );
}

#[tokio::test]
async fn test_above_minimum() {
    // given
    let app_context = Some("SOL/warp-route".to_string());
    let amount = U256::one() * 2;
    let minimum = U256::one();
    let token_message = TokenMessage::new(H256::zero(), amount, vec![]);
    let message = HyperlaneMessage {
        recipient: hex_or_base58_to_h256("8DtAGQpcMuD5sG3KdxDy49ydqXUggR1LQtebh2TECbAc").unwrap(),
        body: encode(token_message),
        ..Default::default()
    };
    let check_account_does_not_exist_and_get_minimum = |_: H256| async move { Some(minimum) };

    // when
    let report = SealevelApplicationOperationVerifier::verify_message(
        &app_context,
        &message,
        check_account_does_not_exist_and_get_minimum,
    )
    .await;

    // then
    assert!(report.is_none());
}

fn encode(token_message: TokenMessage) -> Vec<u8> {
    let mut encoded = vec![];
    token_message.write_to(&mut encoded).unwrap();
    encoded
}
