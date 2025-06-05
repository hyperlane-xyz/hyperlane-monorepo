use ethers_core::abi::Function;
use ethers_core::types::transaction::eip2718::TypedTransaction;

use hyperlane_core::U256;

use crate::transaction::{Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData};
use crate::TransactionDropReason;

use super::super::super::{transaction::Precursor, EthereumTxPrecursor};
use super::{NonceAction, NonceManagerState, NonceStatus};

#[tokio::test]
async fn test_insert_nonce_status() {
    let state = NonceManagerState::new();

    let nonce = U256::from(1);

    state.insert_nonce_status(nonce, NonceStatus::Free).await;

    let (status, lowest_nonce) = state.get_nonce_status_and_lowest_nonce(&nonce).await;
    assert_eq!(status, Some(NonceStatus::Free));
    assert_eq!(lowest_nonce, U256::zero());

    let upper_nonce = {
        let guard = state.inner.lock().await;
        guard.upper_nonce
    };
    assert_eq!(upper_nonce, nonce + 1);
}

#[tokio::test]
async fn test_update_nonce_status_taken() {
    let state = NonceManagerState::new();

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(1);
    let nonce_status = NonceStatus::Taken(tx_uuid.clone());

    state
        .update_nonce_status(nonce, nonce_status, &tx_uuid)
        .await;

    let (status, lowest_nonce) = state.get_nonce_status_and_lowest_nonce(&nonce).await;
    assert_eq!(status, Some(NonceStatus::Taken(tx_uuid)));
    assert_eq!(lowest_nonce, U256::zero());
}

#[tokio::test]
async fn test_update_nonce_status_committed() {
    let state = NonceManagerState::new();

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(1);
    let nonce_status = NonceStatus::Committed(tx_uuid.clone());

    state
        .update_nonce_status(nonce, nonce_status, &tx_uuid)
        .await;

    let (status, lowest_nonce) = state.get_nonce_status_and_lowest_nonce(&nonce).await;
    assert_eq!(status, Some(NonceStatus::Committed(tx_uuid)));
    assert_eq!(lowest_nonce, U256::zero());
}

#[tokio::test]
async fn test_update_nonce_status_free() {
    let state = NonceManagerState::new();

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(1);
    let nonce_status = NonceStatus::Free;

    state
        .update_nonce_status(nonce, nonce_status, &tx_uuid)
        .await;

    let (status, lowest_nonce) = state.get_nonce_status_and_lowest_nonce(&nonce).await;
    assert_eq!(status, Some(NonceStatus::Free));
    assert_eq!(lowest_nonce, U256::zero());
}

#[tokio::test]
async fn test_validate_assigned_nonce() {
    let state = NonceManagerState::new();
    let nonce = U256::from(1);
    let tx_uuid = TransactionUuid::default();

    // Test for Free status
    state.insert_nonce_status(nonce, NonceStatus::Free).await;
    let action = state.validate_assigned_nonce(&nonce, &tx_uuid).await;
    assert_eq!(action, NonceAction::AssignNew);

    // Test for Taken status
    state
        .insert_nonce_status(nonce, NonceStatus::Taken(tx_uuid.clone()))
        .await;
    let action = state.validate_assigned_nonce(&nonce, &tx_uuid).await;
    assert_eq!(action, NonceAction::Noop);

    // Test for Committed status
    state
        .insert_nonce_status(nonce, NonceStatus::Committed(tx_uuid.clone()))
        .await;
    let action = state.validate_assigned_nonce(&nonce, &tx_uuid).await;
    assert_eq!(action, NonceAction::Noop);

    // Test for nonexistent nonce
    let nonexistent_nonce = U256::from(2);
    let action = state
        .validate_assigned_nonce(&nonexistent_nonce, &tx_uuid)
        .await;
    assert_eq!(action, NonceAction::AssignNew);
}

#[tokio::test]
async fn test_identify_next_nonce_comprehensive() {
    let state = NonceManagerState::new();
    let nonce1 = U256::from(1); // Free nonce
    let nonce2 = U256::from(2); // Taken nonce
    let nonce3 = U256::from(3); // Committed nonce
    let nonce4 = U256::from(4); // Free nonce
    let tx_uuid = TransactionUuid::default();

    state.insert_nonce_status(nonce1, NonceStatus::Free).await;
    state
        .insert_nonce_status(nonce2, NonceStatus::Taken(tx_uuid.clone()))
        .await;
    state
        .insert_nonce_status(nonce3, NonceStatus::Committed(tx_uuid.clone()))
        .await;
    state.insert_nonce_status(nonce4, NonceStatus::Free).await;

    let next_nonce = state.identify_next_nonce().await;
    assert_eq!(next_nonce, nonce1); // The smallest free nonce should be returned

    // Remove the smallest free nonce and check again
    state
        .insert_nonce_status(nonce1, NonceStatus::Taken(tx_uuid.clone()))
        .await;
    let next_nonce = state.identify_next_nonce().await;
    assert_eq!(next_nonce, nonce4); // The next smallest free nonce should be returned

    // If no free nonce exists, upper_nonce should be returned
    state
        .insert_nonce_status(nonce4, NonceStatus::Taken(tx_uuid.clone()))
        .await;
    let next_nonce = state.identify_next_nonce().await;
    let guard = state.inner.lock().await;
    assert_eq!(next_nonce, guard.upper_nonce);
}
