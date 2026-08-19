use std::sync::Arc;

use ethers_core::types::Address;

use hyperlane_core::{HyperlaneDomain, U256};

use crate::tests::test_utils::tmp_dbs;

use super::super::super::super::metrics::EthereumAdapterMetrics;
use super::super::super::db::ReorgedNonceRange;
use super::super::NonceManagerState;

#[tokio::test]
async fn test_update_boundary_nonces_sets_finalized_and_upper_when_upper_missing() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let finalized = U256::from(5);

    // No upper nonce set, it should set both finalized and upper (finalized + 1)
    state.update_boundary_nonces(&finalized).await.unwrap();

    let stored_finalized = state.get_finalized_nonce().await.unwrap();
    let stored_upper = state.get_upper_nonce().await.unwrap();

    assert_eq!(stored_finalized, Some(finalized));
    assert_eq!(stored_upper, finalized + 1);

    // Check metrics
    assert_eq!(
        state.metrics.get_finalized_nonce() as u64,
        finalized.as_u64()
    );
    assert_eq!(
        state.metrics.get_upper_nonce() as u64,
        (finalized + 1).as_u64()
    );
}

#[tokio::test]
async fn test_update_boundary_nonces_persists_and_merges_regressions() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = Arc::new(NonceManagerState::new(
        nonce_db.clone(),
        tx_db.clone(),
        address,
        EthereumAdapterMetrics::dummy_instance(),
    ));

    state
        .update_boundary_nonces(&U256::from(100))
        .await
        .unwrap();
    state.update_boundary_nonces(&U256::from(90)).await.unwrap();
    state.update_boundary_nonces(&U256::from(95)).await.unwrap();
    state.update_boundary_nonces(&U256::from(80)).await.unwrap();

    let restarted_state = NonceManagerState::new(
        nonce_db,
        tx_db,
        address,
        EthereumAdapterMetrics::dummy_instance(),
    );
    assert_eq!(
        restarted_state.get_reorged_nonce_range().await.unwrap(),
        Some(ReorgedNonceRange {
            start: U256::from(81),
            end: U256::from(100),
        })
    );
}

#[tokio::test]
async fn test_new_regression_extends_pending_range_until_boundary_recovers() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(
        nonce_db,
        tx_db,
        address,
        EthereumAdapterMetrics::dummy_instance(),
    );

    state
        .update_boundary_nonces(&U256::from(100))
        .await
        .unwrap();
    state.update_boundary_nonces(&U256::from(90)).await.unwrap();
    state.update_boundary_nonces(&U256::from(80)).await.unwrap();

    assert_eq!(
        state.get_reorged_nonce_range().await.unwrap(),
        Some(ReorgedNonceRange {
            start: U256::from(81),
            end: U256::from(100),
        })
    );

    state.update_boundary_nonces(&U256::from(99)).await.unwrap();
    assert!(state.get_reorged_nonce_range().await.unwrap().is_some());

    state
        .update_boundary_nonces(&U256::from(100))
        .await
        .unwrap();
    assert_eq!(state.get_reorged_nonce_range().await.unwrap(), None);
}

#[tokio::test]
async fn test_update_boundary_nonces_captures_regression_to_no_transactions() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let state = NonceManagerState::new(
        nonce_db,
        tx_db,
        address,
        EthereumAdapterMetrics::dummy_instance(),
    );
    state.update_boundary_nonces(&U256::from(3)).await.unwrap();

    state.update_boundary_nonces_from_chain(None).await.unwrap();

    assert_eq!(state.get_finalized_nonce().await.unwrap(), None);
    assert_eq!(
        state.get_reorged_nonce_range().await.unwrap(),
        Some(ReorgedNonceRange {
            start: U256::zero(),
            end: U256::from(3),
        })
    );
}

#[tokio::test]
async fn test_update_boundary_nonces_does_not_update_upper_when_finalized_below_upper() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

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

    // Check metrics
    assert_eq!(
        state.metrics.get_finalized_nonce() as u64,
        finalized.as_u64()
    );
    assert_eq!(state.metrics.get_upper_nonce() as u64, upper.as_u64());
}

#[tokio::test]
async fn test_update_boundary_nonces_updates_upper_when_finalized_equals_upper() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

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

    // Check metrics
    assert_eq!(
        state.metrics.get_finalized_nonce() as u64,
        finalized.as_u64()
    );
    assert_eq!(
        state.metrics.get_upper_nonce() as u64,
        (finalized + 1).as_u64()
    );
}

#[tokio::test]
async fn test_update_boundary_nonces_updates_upper_when_finalized_above_upper() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

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

    // Check metrics
    assert_eq!(
        state.metrics.get_finalized_nonce() as u64,
        finalized.as_u64()
    );
    assert_eq!(
        state.metrics.get_upper_nonce() as u64,
        (finalized + 1).as_u64()
    );
}

#[tokio::test]
async fn test_update_boundary_nonces_finalized_decreases() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

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

    // Check metrics
    assert_eq!(
        state.metrics.get_finalized_nonce() as u64,
        finalized_low.as_u64()
    );
    assert_eq!(state.metrics.get_upper_nonce() as u64, upper.as_u64());
}

#[tokio::test]
async fn test_update_boundary_nonces_multiple_calls_and_idempotency() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let finalized1 = U256::from(2);
    let finalized2 = U256::from(5);
    let finalized3 = U256::from(5);

    // Initial call, sets finalized and upper
    state.update_boundary_nonces(&finalized1).await.unwrap();
    assert_eq!(state.get_finalized_nonce().await.unwrap(), Some(finalized1));
    assert_eq!(state.get_upper_nonce().await.unwrap(), finalized1 + 1);

    assert_eq!(
        state.metrics.get_finalized_nonce() as u64,
        finalized1.as_u64()
    );
    assert_eq!(
        state.metrics.get_upper_nonce() as u64,
        (finalized1 + 1).as_u64()
    );

    // Second call with higher finalized, it should update both
    state.update_boundary_nonces(&finalized2).await.unwrap();
    assert_eq!(state.get_finalized_nonce().await.unwrap(), Some(finalized2));
    assert_eq!(state.get_upper_nonce().await.unwrap(), finalized2 + 1);

    assert_eq!(
        state.metrics.get_finalized_nonce() as u64,
        finalized2.as_u64()
    );
    assert_eq!(
        state.metrics.get_upper_nonce() as u64,
        (finalized2 + 1).as_u64()
    );

    // Third call with same finalized, it should not change upper
    state.update_boundary_nonces(&finalized3).await.unwrap();
    assert_eq!(state.get_finalized_nonce().await.unwrap(), Some(finalized3));
    assert_eq!(state.get_upper_nonce().await.unwrap(), finalized2 + 1);

    assert_eq!(
        state.metrics.get_finalized_nonce() as u64,
        finalized3.as_u64()
    );
    assert_eq!(
        state.metrics.get_upper_nonce() as u64,
        (finalized3 + 1).as_u64()
    );
}
