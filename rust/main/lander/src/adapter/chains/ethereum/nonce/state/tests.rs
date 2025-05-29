use ethers_core::abi::Function;
use ethers_core::types::transaction::eip2718::TypedTransaction;

use hyperlane_core::U256;

use crate::transaction::{Transaction, TransactionStatus, VmSpecificTxData};
use crate::TransactionDropReason;

use super::super::super::{transaction::Precursor, EthereumTxPrecursor};
use super::{NonceAction, NonceManagerState, NonceStatus};

#[tokio::test]
async fn test_insert_nonce_status() {
    let state = NonceManagerState::new();
    let nonce = U256::from(1);

    state.insert_nonce_status(&nonce, NonceStatus::Free).await;

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
async fn test_update_nonce_status_pending_inclusion() {
    let state = NonceManagerState::new();
    let nonce = U256::from(1);

    let mut tx = dummy_tx();
    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(nonce);

    state
        .update_nonce_status(&tx, &TransactionStatus::PendingInclusion)
        .await;

    let (status, lowest_nonce) = state.get_nonce_status_and_lowest_nonce(&nonce).await;
    assert_eq!(status, Some(NonceStatus::Taken));
    assert_eq!(lowest_nonce, U256::zero());
}

#[tokio::test]
async fn test_update_nonce_status_mempool() {
    let state = NonceManagerState::new();
    let nonce = U256::from(1);

    let mut tx = dummy_tx();
    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(nonce);

    state
        .update_nonce_status(&tx, &TransactionStatus::Mempool)
        .await;

    let (status, lowest_nonce) = state.get_nonce_status_and_lowest_nonce(&nonce).await;
    assert_eq!(status, Some(NonceStatus::Taken));
    assert_eq!(lowest_nonce, U256::zero());
}

#[tokio::test]
async fn test_update_nonce_status_included() {
    let state = NonceManagerState::new();
    let nonce = U256::from(1);

    let mut tx = dummy_tx();
    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(nonce);

    state
        .update_nonce_status(&tx, &TransactionStatus::Included)
        .await;

    let (status, lowest_nonce) = state.get_nonce_status_and_lowest_nonce(&nonce).await;
    assert_eq!(status, Some(NonceStatus::Taken));
    assert_eq!(lowest_nonce, U256::zero());
}

#[tokio::test]
async fn test_update_nonce_status_finalized() {
    let state = NonceManagerState::new();
    let nonce = U256::from(1);

    let mut tx = dummy_tx();
    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(nonce);

    state
        .update_nonce_status(&tx, &TransactionStatus::Finalized)
        .await;

    let (status, lowest_nonce) = state.get_nonce_status_and_lowest_nonce(&nonce).await;
    assert_eq!(status, Some(NonceStatus::Committed));
    assert_eq!(lowest_nonce, U256::zero());
}

#[tokio::test]
async fn test_update_nonce_status_dropped() {
    let state = NonceManagerState::new();
    let nonce = U256::from(1);

    let mut tx = dummy_tx();
    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(nonce);

    state
        .update_nonce_status(
            &tx,
            &TransactionStatus::Dropped(TransactionDropReason::DroppedByChain),
        )
        .await;

    let (status, lowest_nonce) = state.get_nonce_status_and_lowest_nonce(&nonce).await;
    assert_eq!(status, Some(NonceStatus::Free));
    assert_eq!(lowest_nonce, U256::zero());
}

#[tokio::test]
async fn test_update_nonce_status_no_nonce() {
    let state = NonceManagerState::new();

    let tx = dummy_tx(); // Transaction without an assigned nonce

    state
        .update_nonce_status(&tx, &TransactionStatus::PendingInclusion)
        .await;

    // Ensure no status is updated since the transaction has no nonce
    let guard = state.inner.lock().await;
    assert!(guard.nonces.is_empty());
}

#[tokio::test]
async fn test_validate_assigned_nonce() {
    let state = NonceManagerState::new();
    let nonce = U256::from(1);

    // Test for Free status
    state.insert_nonce_status(&nonce, NonceStatus::Free).await;
    let action = state.validate_assigned_nonce(&nonce).await;
    assert_eq!(action, NonceAction::Reassign);

    // Test for Taken status
    state.insert_nonce_status(&nonce, NonceStatus::Taken).await;
    let action = state.validate_assigned_nonce(&nonce).await;
    assert_eq!(action, NonceAction::Noop);

    // Test for Committed status
    state
        .insert_nonce_status(&nonce, NonceStatus::Committed)
        .await;
    let action = state.validate_assigned_nonce(&nonce).await;
    assert_eq!(action, NonceAction::Noop);

    // Test for nonexistent nonce
    let nonexistent_nonce = U256::from(2);
    let action = state.validate_assigned_nonce(&nonexistent_nonce).await;
    assert_eq!(action, NonceAction::Reassign);
}

#[tokio::test]
async fn test_identify_next_nonce_comprehensive() {
    let state = NonceManagerState::new();
    let nonce1 = U256::from(1); // Free nonce
    let nonce2 = U256::from(2); // Taken nonce
    let nonce3 = U256::from(3); // Committed nonce
    let nonce4 = U256::from(4); // Free nonce

    state.insert_nonce_status(&nonce1, NonceStatus::Free).await;
    state.insert_nonce_status(&nonce2, NonceStatus::Taken).await;
    state
        .insert_nonce_status(&nonce3, NonceStatus::Committed)
        .await;
    state.insert_nonce_status(&nonce4, NonceStatus::Free).await;

    let next_nonce = state.identify_next_nonce().await;
    assert_eq!(next_nonce, nonce1); // The smallest free nonce should be returned

    // Remove the smallest free nonce and check again
    state.insert_nonce_status(&nonce1, NonceStatus::Taken).await;
    let next_nonce = state.identify_next_nonce().await;
    assert_eq!(next_nonce, nonce4); // The next smallest free nonce should be returned

    // If no free nonce exists, upper_nonce should be returned
    state.insert_nonce_status(&nonce4, NonceStatus::Taken).await;
    let next_nonce = state.identify_next_nonce().await;
    let guard = state.inner.lock().await;
    assert_eq!(next_nonce, guard.upper_nonce);
}

fn dummy_tx() -> Transaction {
    #[allow(deprecated)]
    let precursor = EthereumTxPrecursor {
        tx: TypedTransaction::default(),
        function: Function {
            name: "".to_string(),
            inputs: vec![],
            outputs: vec![],
            constant: None,
            state_mutability: Default::default(),
        },
    };

    Transaction {
        uuid: Default::default(),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Evm(precursor),
        payload_details: vec![],
        status: Default::default(),
        submission_attempts: 0,
        creation_timestamp: Default::default(),
        last_submission_attempt: None,
    }
}
