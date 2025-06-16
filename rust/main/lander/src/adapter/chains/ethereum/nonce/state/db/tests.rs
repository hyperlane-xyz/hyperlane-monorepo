use std::sync::Arc;

use ethers_core::types::Address;

use hyperlane_core::U256;

use crate::tests::test_utils::tmp_dbs;
use crate::transaction::TransactionUuid;

use super::super::NonceManagerState;

#[tokio::test]
async fn test_get_and_set_tracked_tx_uuid() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    let nonce = U256::from(1);
    let tx_uuid = TransactionUuid::random();

    // Initially should be default
    let tracked = state.get_tracked_tx_uuid(&nonce).await.unwrap();
    assert_eq!(tracked, TransactionUuid::default());

    // Set and get
    state.set_tracked_tx_uuid(&nonce, &tx_uuid).await.unwrap();
    let tracked = state.get_tracked_tx_uuid(&nonce).await.unwrap();
    assert_eq!(tracked, tx_uuid);

    // Overwrite
    let tx_uuid2 = TransactionUuid::random();
    state.set_tracked_tx_uuid(&nonce, &tx_uuid2).await.unwrap();
    let tracked = state.get_tracked_tx_uuid(&nonce).await.unwrap();
    assert_eq!(tracked, tx_uuid2);
}

#[tokio::test]
async fn test_clear_tracked_tx_uuid() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    let nonce = U256::from(2);
    let tx_uuid = TransactionUuid::random();

    state.set_tracked_tx_uuid(&nonce, &tx_uuid).await.unwrap();
    let tracked = state.get_tracked_tx_uuid(&nonce).await.unwrap();
    assert_eq!(tracked, tx_uuid);

    state.clear_tracked_tx_uuid(&nonce).await.unwrap();
    let tracked = state.get_tracked_tx_uuid(&nonce).await.unwrap();
    assert_eq!(tracked, TransactionUuid::default());
}

#[tokio::test]
async fn test_get_and_set_upper_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    // Default should be zero
    let upper = state.get_upper_nonce().await.unwrap();
    assert_eq!(upper, U256::zero());

    // Set and get
    let new_upper = U256::from(10);
    state.set_upper_nonce(&new_upper).await.unwrap();
    let upper = state.get_upper_nonce().await.unwrap();
    assert_eq!(upper, new_upper);

    // Overwrite
    let new_upper2 = U256::from(20);
    state.set_upper_nonce(&new_upper2).await.unwrap();
    let upper = state.get_upper_nonce().await.unwrap();
    assert_eq!(upper, new_upper2);
}

#[tokio::test]
async fn test_get_finalized_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    // Default should be None
    let finalized = state.get_finalized_nonce().await.unwrap();
    assert_eq!(finalized, None);

    // Set and get
    let val = U256::from(5);
    state.set_finalized_nonce(&val).await.unwrap();
    let finalized = state.get_finalized_nonce().await.unwrap();
    assert_eq!(finalized, Some(val));

    // Overwrite
    let val2 = U256::from(8);
    state.set_finalized_nonce(&val2).await.unwrap();
    let finalized = state.get_finalized_nonce().await.unwrap();
    assert_eq!(finalized, Some(val2));
}

#[tokio::test]
async fn test_get_boundary_nonces() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    // Both defaults
    let (finalized, upper) = state.get_boundary_nonces().await.unwrap();
    assert_eq!(finalized, None);
    assert_eq!(upper, U256::zero());

    // Set finalized and upper
    let finalized_val = U256::from(3);
    let upper_val = U256::from(7);
    state.set_finalized_nonce(&finalized_val).await.unwrap();
    state.set_upper_nonce(&upper_val).await.unwrap();

    let (finalized, upper) = state.get_boundary_nonces().await.unwrap();
    assert_eq!(finalized, Some(finalized_val));
    assert_eq!(upper, upper_val);
}

#[tokio::test]
async fn test_tracked_tx_uuid_multiple_nonces_and_addresses() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address1 = Address::random();
    let address2 = Address::random();
    let state1 = NonceManagerState::new(nonce_db.clone(), tx_db.clone(), address1);
    let state2 = NonceManagerState::new(nonce_db, tx_db, address2);

    let nonce1 = U256::from(100);
    let nonce2 = U256::from(200);
    let tx_uuid1 = TransactionUuid::random();
    let tx_uuid2 = TransactionUuid::random();

    // Set for (nonce1, address1)
    state1
        .set_tracked_tx_uuid(&nonce1, &tx_uuid1)
        .await
        .unwrap();
    // Set for (nonce2, address2)
    state2
        .set_tracked_tx_uuid(&nonce2, &tx_uuid2)
        .await
        .unwrap();

    // Should not interfere
    assert_eq!(state1.get_tracked_tx_uuid(&nonce1).await.unwrap(), tx_uuid1);
    assert_eq!(state2.get_tracked_tx_uuid(&nonce2).await.unwrap(), tx_uuid2);

    // Unset combinations should be default
    assert_eq!(
        state1.get_tracked_tx_uuid(&nonce2).await.unwrap(),
        TransactionUuid::default()
    );
    assert_eq!(
        state2.get_tracked_tx_uuid(&nonce1).await.unwrap(),
        TransactionUuid::default()
    );
}

#[tokio::test]
async fn test_clear_tracked_tx_uuid_idempotency() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    let nonce = U256::from(300);

    // Clear when nothing set
    state.clear_tracked_tx_uuid(&nonce).await.unwrap();
    assert_eq!(
        state.get_tracked_tx_uuid(&nonce).await.unwrap(),
        TransactionUuid::default()
    );

    // Set, then clear twice
    let tx_uuid = TransactionUuid::random();
    state.set_tracked_tx_uuid(&nonce, &tx_uuid).await.unwrap();
    state.clear_tracked_tx_uuid(&nonce).await.unwrap();
    state.clear_tracked_tx_uuid(&nonce).await.unwrap();
    assert_eq!(
        state.get_tracked_tx_uuid(&nonce).await.unwrap(),
        TransactionUuid::default()
    );
}

#[tokio::test]
async fn test_set_upper_nonce_lower_than_existing() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    let upper1 = U256::from(50);
    let upper2 = U256::from(20);

    state.set_upper_nonce(&upper1).await.unwrap();
    // Overwrite with lower value
    state.set_upper_nonce(&upper2).await.unwrap();
    let upper = state.get_upper_nonce().await.unwrap();
    assert_eq!(upper, upper2);
}

#[tokio::test]
async fn test_set_and_get_finalized_nonce_none_and_overwrite() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    // Should be None initially
    assert_eq!(state.get_finalized_nonce().await.unwrap(), None);

    // Set and overwrite
    let val1 = U256::from(5);
    let val2 = U256::from(15);
    state.set_finalized_nonce(&val1).await.unwrap();
    assert_eq!(state.get_finalized_nonce().await.unwrap(), Some(val1));
    state.set_finalized_nonce(&val2).await.unwrap();
    assert_eq!(state.get_finalized_nonce().await.unwrap(), Some(val2));
}

#[tokio::test]
async fn test_get_boundary_nonces_with_only_one_set() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db.clone(), tx_db.clone(), address);

    let finalized_val = U256::from(7);
    let upper_val = U256::from(13);

    // Only finalized set
    state.set_finalized_nonce(&finalized_val).await.unwrap();
    let (finalized, upper) = state.get_boundary_nonces().await.unwrap();
    assert_eq!(finalized, Some(finalized_val));
    assert_eq!(upper, U256::zero());

    // Only upper set (clear finalized by using a new address)
    let address2 = Address::random();
    let state2 = NonceManagerState::new(nonce_db, tx_db, address2);
    state2.set_upper_nonce(&upper_val).await.unwrap();
    let (finalized, upper) = state2.get_boundary_nonces().await.unwrap();
    assert_eq!(finalized, None);
    assert_eq!(upper, upper_val);
}
