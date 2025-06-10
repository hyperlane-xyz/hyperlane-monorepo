use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ethers_core::types::Address;

use hyperlane_base::db::DbResult;
use hyperlane_core::U256;

use crate::transaction::TransactionUuid;

use super::super::tests::MockNonceDb;
use super::NonceDb;
use super::NonceError;
use super::NonceManagerState;
use super::NonceStatus;

#[tokio::test]
async fn test_update_nonce_status_inserts_when_not_tracked() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(10);

    // Not tracked: should insert
    state
        .update_nonce_status(&nonce, &NonceStatus::Freed(tx_uuid.clone()))
        .await
        .unwrap();
    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &signer)
        .await
        .unwrap();
    assert_eq!(status, Some(NonceStatus::Freed(tx_uuid.clone())));
}

#[tokio::test]
async fn test_update_nonce_status_noop_when_same_status() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(11);

    // Insert initial status
    state
        .update_nonce_status(&nonce, &NonceStatus::Taken(tx_uuid.clone()))
        .await
        .unwrap();

    // Should be noop (no error, no change)
    state
        .update_nonce_status(&nonce, &NonceStatus::Taken(tx_uuid.clone()))
        .await
        .unwrap();

    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &signer)
        .await
        .unwrap();
    assert_eq!(status, Some(NonceStatus::Taken(tx_uuid.clone())));
}

#[tokio::test]
async fn test_update_nonce_status_freed_to_taken() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(12);

    // Insert Freed
    state
        .update_nonce_status(&nonce, &NonceStatus::Freed(tx_uuid.clone()))
        .await
        .unwrap();

    // Freed -> Taken (should update)
    state
        .update_nonce_status(&nonce, &NonceStatus::Taken(tx_uuid.clone()))
        .await
        .unwrap();

    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &signer)
        .await
        .unwrap();
    assert_eq!(status, Some(NonceStatus::Taken(tx_uuid.clone())));
}

#[tokio::test]
async fn test_update_nonce_status_same_tx_uuid_updates_status() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(13);

    // Insert Taken
    state
        .update_nonce_status(&nonce, &NonceStatus::Taken(tx_uuid.clone()))
        .await
        .unwrap();

    // Taken -> Committed (same tx_uuid, should update)
    state
        .update_nonce_status(&nonce, &NonceStatus::Committed(tx_uuid.clone()))
        .await
        .unwrap();

    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &signer)
        .await
        .unwrap();
    assert_eq!(status, Some(NonceStatus::Committed(tx_uuid.clone())));
}

#[tokio::test]
async fn test_update_nonce_status_different_tx_uuid_errors() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid1 = TransactionUuid::random();
    let tx_uuid2 = TransactionUuid::random();
    let nonce = U256::from(14);

    // Insert Taken with tx_uuid1
    state
        .update_nonce_status(&nonce, &NonceStatus::Taken(tx_uuid1.clone()))
        .await
        .unwrap();

    // Try to update to Taken with tx_uuid2 (should error)
    let result = state
        .update_nonce_status(&nonce, &NonceStatus::Taken(tx_uuid2.clone()))
        .await;

    assert!(result.is_err());
    if let Err(NonceError::NonceAssignedToMultipleTransactions(n, tracked, new)) = result {
        assert_eq!(n, nonce);
        assert_eq!(tracked, tx_uuid1);
        assert_eq!(new, tx_uuid2);
    } else {
        panic!("Expected NonceAssignedToMultipleTransactions error");
    }
}

#[tokio::test]
async fn test_validate_assigned_nonce_not_tracked_returns_assign() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(1);

    // Not tracked: should assign
    let status = NonceStatus::Freed(tx_uuid.clone());
    let action = state
        .validate_assigned_nonce(&nonce, &status)
        .await
        .unwrap();
    assert_eq!(action, super::NonceAction::Assign);
}

#[tokio::test]
async fn test_validate_assigned_nonce_tracked_different_tx_uuid_returns_assign() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid1 = TransactionUuid::random();
    let tx_uuid2 = TransactionUuid::random();
    let nonce = U256::from(2);

    // Tracked with different tx_uuid
    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &signer,
        &NonceStatus::Taken(tx_uuid1.clone()),
    )
    .await
    .unwrap();

    let status = NonceStatus::Taken(tx_uuid2.clone());
    let action = state
        .validate_assigned_nonce(&nonce, &status)
        .await
        .unwrap();
    assert_eq!(action, super::NonceAction::Assign);
}

#[tokio::test]
async fn test_validate_assigned_nonce_freed_returns_assign() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(3);

    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &signer,
        &NonceStatus::Freed(tx_uuid.clone()),
    )
    .await
    .unwrap();

    let status = NonceStatus::Freed(tx_uuid.clone());
    let action = state
        .validate_assigned_nonce(&nonce, &status)
        .await
        .unwrap();
    assert_eq!(action, super::NonceAction::Assign);
}

#[tokio::test]
async fn test_validate_assigned_nonce_taken_below_lowest_returns_assign() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(4);

    // Set the lowest nonce to 10
    db.store_lowest_available_nonce_by_signer_address(&signer, &U256::from(10))
        .await
        .unwrap();

    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &signer,
        &NonceStatus::Taken(tx_uuid.clone()),
    )
    .await
    .unwrap();

    let status = NonceStatus::Taken(tx_uuid.clone());
    let action = state
        .validate_assigned_nonce(&nonce, &status)
        .await
        .unwrap();
    assert_eq!(action, super::NonceAction::Assign);
}

#[tokio::test]
async fn test_validate_assigned_nonce_taken_above_lowest_returns_noop() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(20);

    // Set the lowest nonce to 10
    db.store_lowest_available_nonce_by_signer_address(&signer, &U256::from(10))
        .await
        .unwrap();

    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &signer,
        &NonceStatus::Taken(tx_uuid.clone()),
    )
    .await
    .unwrap();

    let status = NonceStatus::Taken(tx_uuid.clone());
    let action = state
        .validate_assigned_nonce(&nonce, &status)
        .await
        .unwrap();
    assert_eq!(action, super::NonceAction::Noop);
}

#[tokio::test]
async fn test_validate_assigned_nonce_committed_returns_noop() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid = TransactionUuid::random();
    let nonce = U256::from(30);

    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &signer,
        &NonceStatus::Committed(tx_uuid.clone()),
    )
    .await
    .unwrap();

    let status = NonceStatus::Committed(tx_uuid.clone());
    let action = state
        .validate_assigned_nonce(&nonce, &status)
        .await
        .unwrap();
    assert_eq!(action, super::NonceAction::Noop);
}

#[tokio::test]
async fn test_assign_next_nonce_no_tracked_nonces() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    let tx_uuid = TransactionUuid::random();
    let status = NonceStatus::Freed(tx_uuid.clone());

    // No nonces tracked, should assign 0
    let assigned = state.assign_next_nonce(&status).await.unwrap();
    assert_eq!(assigned, U256::zero());
}

#[tokio::test]
async fn test_assign_next_nonce_with_freed_and_taken_nonces() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    // Set boundary nonces
    db.store_lowest_available_nonce_by_signer_address(&signer, &U256::zero())
        .await
        .unwrap();
    db.store_upper_nonce_by_signer_address(&signer, &U256::from(3))
        .await
        .unwrap();

    let tx_uuid1 = TransactionUuid::random();
    let tx_uuid2 = TransactionUuid::random();
    let tx_uuid3 = TransactionUuid::random();

    // 0: Taken, 1: Freed, 2: Taken
    db.store_nonce_status_by_nonce_and_signer_address(
        &U256::zero(),
        &signer,
        &NonceStatus::Taken(tx_uuid1.clone()),
    )
    .await
    .unwrap();
    db.store_nonce_status_by_nonce_and_signer_address(
        &U256::one(),
        &signer,
        &NonceStatus::Freed(tx_uuid2.clone()),
    )
    .await
    .unwrap();
    db.store_nonce_status_by_nonce_and_signer_address(
        &U256::from(2),
        &signer,
        &NonceStatus::Taken(tx_uuid3.clone()),
    )
    .await
    .unwrap();

    // Should assign 1 (the first Freed nonce)
    let status = NonceStatus::Freed(tx_uuid2.clone());
    let assigned = state.assign_next_nonce(&status).await.unwrap();
    assert_eq!(assigned, U256::one());
}

#[tokio::test]
async fn test_assign_next_nonce_all_taken_extends_upper() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    // Set boundary nonces
    db.store_lowest_available_nonce_by_signer_address(&signer, &U256::zero())
        .await
        .unwrap();
    db.store_upper_nonce_by_signer_address(&signer, &U256::from(2))
        .await
        .unwrap();

    let tx_uuid1 = TransactionUuid::random();
    let tx_uuid2 = TransactionUuid::random();

    // 0: Taken, 1: Taken
    db.store_nonce_status_by_nonce_and_signer_address(
        &U256::zero(),
        &signer,
        &NonceStatus::Taken(tx_uuid1.clone()),
    )
    .await
    .unwrap();
    db.store_nonce_status_by_nonce_and_signer_address(
        &U256::one(),
        &signer,
        &NonceStatus::Taken(tx_uuid2.clone()),
    )
    .await
    .unwrap();

    // Should assign 2 (extend upper nonce)
    let status = NonceStatus::Freed(TransactionUuid::random());
    let assigned = state.assign_next_nonce(&status).await.unwrap();
    assert_eq!(assigned, U256::from(2));

    // Upper nonce should now be 3
    let upper = db
        .retrieve_upper_nonce_by_signer_address(&signer)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(upper, U256::from(3));
}

#[tokio::test]
async fn test_assign_next_nonce_freed_at_upper() {
    let db = Arc::new(MockNonceDb::new());
    let signer = Address::random();
    let state = NonceManagerState::new(db.clone(), signer);

    // Set boundary nonces
    db.store_lowest_available_nonce_by_signer_address(&signer, &U256::from(5))
        .await
        .unwrap();
    db.store_upper_nonce_by_signer_address(&signer, &U256::from(7))
        .await
        .unwrap();

    let tx_uuid = TransactionUuid::random();

    // 5: Freed, 6: Taken
    db.store_nonce_status_by_nonce_and_signer_address(
        &U256::from(5),
        &signer,
        &NonceStatus::Freed(tx_uuid.clone()),
    )
    .await
    .unwrap();
    db.store_nonce_status_by_nonce_and_signer_address(
        &U256::from(6),
        &signer,
        &NonceStatus::Taken(TransactionUuid::random()),
    )
    .await
    .unwrap();

    // Should assign 5 (first Freed)
    let status = NonceStatus::Freed(tx_uuid.clone());
    let assigned = state.assign_next_nonce(&status).await.unwrap();
    assert_eq!(assigned, U256::from(5));
}
