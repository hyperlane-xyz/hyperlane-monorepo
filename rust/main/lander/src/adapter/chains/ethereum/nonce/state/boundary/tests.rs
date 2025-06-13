use ethers_core::types::Address;

use hyperlane_core::U256;

use crate::tests::test_utils::tmp_dbs;

use super::super::NonceManagerState;

#[tokio::test]
async fn test_update_boundary_nonces_sets_finalized_and_upper_when_upper_missing() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    let finalized = U256::from(5);

    // No upper nonce set, it should set both finalized and upper (finalized + 1)
    state.update_boundary_nonces(&finalized).await.unwrap();

    let stored_finalized = state.get_finalized_nonce().await.unwrap();
    let stored_upper = state.get_upper_nonce().await.unwrap();

    assert_eq!(stored_finalized, Some(finalized));
    assert_eq!(stored_upper, finalized + 1);
}

#[tokio::test]
async fn test_update_boundary_nonces_does_not_update_upper_when_finalized_below_upper() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    let upper = U256::from(10);
    let finalized = U256::from(5);

    // Set upper nonce first
    state.set_upper_nonce(&upper).await.unwrap();

    // Finalized < upper, should not update upper
    state.update_boundary_nonces(&finalized).await.unwrap();

    let stored_finalized = state.get_finalized_nonce().await.unwrap();
    let stored_upper = state.get_upper_nonce().await.unwrap();

    assert_eq!(stored_finalized, Some(finalized));
    assert_eq!(stored_upper, upper);
}

#[tokio::test]
async fn test_update_boundary_nonces_updates_upper_when_finalized_equals_upper() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    let upper = U256::from(7);
    let finalized = U256::from(7);

    // Set upper nonce first
    state.set_upper_nonce(&upper).await.unwrap();

    // Finalized == upper, should update upper to value finalized + 1
    state.update_boundary_nonces(&finalized).await.unwrap();

    let stored_finalized = state.get_finalized_nonce().await.unwrap();
    let stored_upper = state.get_upper_nonce().await.unwrap();

    assert_eq!(stored_finalized, Some(finalized));
    assert_eq!(stored_upper, finalized + 1);
}

#[tokio::test]
async fn test_update_boundary_nonces_updates_upper_when_finalized_above_upper() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    let upper = U256::from(3);
    let finalized = U256::from(10);

    // Set upper nonce first
    state.set_upper_nonce(&upper).await.unwrap();

    // Finalized > upper, should update upper to finalized + 1
    state.update_boundary_nonces(&finalized).await.unwrap();

    let stored_finalized = state.get_finalized_nonce().await.unwrap();
    let stored_upper = state.get_upper_nonce().await.unwrap();

    assert_eq!(stored_finalized, Some(finalized));
    assert_eq!(stored_upper, finalized + 1);
}

#[tokio::test]
async fn test_update_boundary_nonces_finalized_decreases() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    // Set upper and finalized to higher value first
    let upper = U256::from(10);
    let finalized_high = U256::from(8);
    state.set_upper_nonce(&upper).await.unwrap();
    state.set_finalized_nonce(&finalized_high).await.unwrap();

    // Now decrease finalized
    let finalized_low = U256::from(3);
    state.update_boundary_nonces(&finalized_low).await.unwrap();

    let stored_finalized = state.get_finalized_nonce().await.unwrap();
    let stored_upper = state.get_upper_nonce().await.unwrap();

    assert_eq!(stored_finalized, Some(finalized_low));
    // Upper should remain unchanged
    assert_eq!(stored_upper, upper);
}

#[tokio::test]
async fn test_update_boundary_nonces_multiple_calls_and_idempotency() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(nonce_db, tx_db, address);

    let finalized1 = U256::from(2);
    let finalized2 = U256::from(5);
    let finalized3 = U256::from(5);

    // Initial call, sets finalized and upper
    state.update_boundary_nonces(&finalized1).await.unwrap();
    assert_eq!(state.get_finalized_nonce().await.unwrap(), Some(finalized1));
    assert_eq!(state.get_upper_nonce().await.unwrap(), finalized1 + 1);

    // Second call with higher finalized, it should update both
    state.update_boundary_nonces(&finalized2).await.unwrap();
    assert_eq!(state.get_finalized_nonce().await.unwrap(), Some(finalized2));
    assert_eq!(state.get_upper_nonce().await.unwrap(), finalized2 + 1);

    // Third call with same finalized, it should not change upper
    state.update_boundary_nonces(&finalized3).await.unwrap();
    assert_eq!(state.get_finalized_nonce().await.unwrap(), Some(finalized3));
    assert_eq!(state.get_upper_nonce().await.unwrap(), finalized2 + 1);
}
