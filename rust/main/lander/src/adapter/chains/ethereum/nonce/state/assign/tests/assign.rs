use std::sync::Arc;

use ethers_core::types::Address;

use hyperlane_core::U256;

use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{DropReason, Transaction, TransactionStatus, TransactionUuid};

use super::super::super::super::super::tests::DOMAIN;
use super::super::super::super::super::EthereumAdapterMetrics;
use super::super::super::super::tests::make_tx;
use super::super::NonceManagerState;

fn create_tx(uuid: TransactionUuid, status: TransactionStatus) -> Transaction {
    make_tx(uuid, status, None, None)
}

#[tokio::test]
async fn test_assign_next_nonce_no_previous_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        (*DOMAIN).clone(),
        nonce_db,
        tx_db,
        address,
        metrics,
    ));

    let tx_uuid = TransactionUuid::random();

    // No previous nonce assigned, should assign 0
    let assigned = state.assign_next_nonce(&tx_uuid, &None).await.unwrap();
    assert_eq!(assigned, U256::zero());
    // Should be tracked
    let tracked = state.get_tracked_tx_uuid(&U256::zero()).await.unwrap();
    assert_eq!(tracked, tx_uuid);
}

#[tokio::test]
async fn test_assign_next_nonce_with_previous_nonce_clears_tracked() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        (*DOMAIN).clone(),
        nonce_db,
        tx_db,
        address,
        metrics,
    ));

    let tx_uuid = TransactionUuid::random();
    let prev_nonce = U256::from(5);

    // Set tracked for previous nonce
    state
        .set_tracked_tx_uuid(&prev_nonce, &tx_uuid)
        .await
        .unwrap();

    // Assign next nonce with previous nonce set
    let assigned = state
        .assign_next_nonce(&tx_uuid, &Some(prev_nonce))
        .await
        .unwrap();
    // Should clear previous and assign new
    assert_ne!(assigned, prev_nonce);
    let tracked_prev = state.get_tracked_tx_uuid(&prev_nonce).await.unwrap();
    assert_eq!(tracked_prev, TransactionUuid::default());
}

#[tokio::test]
async fn test_assign_next_nonce_extends_upper_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        (*DOMAIN).clone(),
        nonce_db,
        tx_db,
        address,
        metrics,
    ));

    let tx_uuid = TransactionUuid::random();

    // Set finalized and upper nonce
    state.set_finalized_nonce(&U256::from(0)).await.unwrap();
    state.set_upper_nonce(&U256::from(1)).await.unwrap();

    // Add tracked nonces and transactions for all nonces in [0, upper_nonce)
    let upper_nonce = U256::from(1);
    for i in 0..upper_nonce.as_u64() {
        let nonce = U256::from(i);
        let uuid = TransactionUuid::random();
        state.set_tracked_tx_uuid(&nonce, &uuid).await.unwrap();
        let tx = create_tx(uuid, TransactionStatus::PendingInclusion);
        state.tx_db.store_transaction_by_uuid(&tx).await.unwrap();
    }

    // All nonces taken, so next should be upper (1), and upper should be incremented to 2
    let assigned = state.assign_next_nonce(&tx_uuid, &None).await.unwrap();
    assert_eq!(assigned, U256::from(1));
    let upper = state.get_upper_nonce().await.unwrap();
    assert_eq!(upper, U256::from(2));
}

#[tokio::test]
async fn test_assign_next_nonce_reuses_freed_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        (*DOMAIN).clone(),
        nonce_db,
        tx_db,
        address,
        metrics,
    ));

    let tx_uuid = TransactionUuid::random();

    // Set finalized and upper nonce
    state.set_finalized_nonce(&U256::from(0)).await.unwrap();
    state.set_upper_nonce(&U256::from(3)).await.unwrap();

    // 0: tracked (Taken), 1: tracked (Freed), 2: tracked (Taken)
    let uuid0 = TransactionUuid::random();
    let uuid1 = TransactionUuid::random();
    let uuid2 = TransactionUuid::random();

    state
        .set_tracked_tx_uuid(&U256::from(0), &uuid0)
        .await
        .unwrap();
    let tx0 = create_tx(uuid0, TransactionStatus::PendingInclusion);
    state.tx_db.store_transaction_by_uuid(&tx0).await.unwrap();

    state
        .set_tracked_tx_uuid(&U256::from(1), &uuid1)
        .await
        .unwrap();
    let tx1 = create_tx(
        uuid1,
        TransactionStatus::Dropped(DropReason::DroppedByChain),
    );
    state.tx_db.store_transaction_by_uuid(&tx1).await.unwrap();

    state
        .set_tracked_tx_uuid(&U256::from(2), &uuid2)
        .await
        .unwrap();
    let tx2 = create_tx(uuid2, TransactionStatus::PendingInclusion);
    state.tx_db.store_transaction_by_uuid(&tx2).await.unwrap();

    // Should assign 1 (the Freed nonce)
    let assigned = state.assign_next_nonce(&tx_uuid, &None).await.unwrap();
    assert_eq!(assigned, U256::from(1));
}

#[tokio::test]
async fn test_assign_next_nonce_gap_in_tracked_nonces() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        (*DOMAIN).clone(),
        nonce_db,
        tx_db,
        address,
        metrics,
    ));

    let tx_uuid = TransactionUuid::random();

    // Set finalized and upper nonce
    state.set_finalized_nonce(&U256::from(0)).await.unwrap();
    state.set_upper_nonce(&U256::from(4)).await.unwrap();

    // 0: tracked (Taken), 2: tracked (Taken), 1 and 3 not tracked
    let uuid0 = TransactionUuid::random();
    let uuid2 = TransactionUuid::random();

    state
        .set_tracked_tx_uuid(&U256::from(0), &uuid0)
        .await
        .unwrap();
    let tx0 = create_tx(uuid0, TransactionStatus::PendingInclusion);
    state.tx_db.store_transaction_by_uuid(&tx0).await.unwrap();

    state
        .set_tracked_tx_uuid(&U256::from(2), &uuid2)
        .await
        .unwrap();
    let tx2 = create_tx(uuid2, TransactionStatus::PendingInclusion);
    state.tx_db.store_transaction_by_uuid(&tx2).await.unwrap();

    // Should assign 1 (first not tracked)
    let assigned = state.assign_next_nonce(&tx_uuid, &None).await.unwrap();
    assert_eq!(assigned, U256::from(1));
}

#[tokio::test]
async fn test_assign_next_nonce_non_existing_tracked_tx() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        (*DOMAIN).clone(),
        nonce_db,
        tx_db,
        address,
        metrics,
    ));

    let tx_uuid = TransactionUuid::random();

    // Set finalized and upper nonce
    state.set_finalized_nonce(&U256::from(0)).await.unwrap();
    state.set_upper_nonce(&U256::from(2)).await.unwrap();

    // 0: tracked, but transaction does not exist
    let uuid = TransactionUuid::random();
    state
        .set_tracked_tx_uuid(&U256::from(0), &uuid)
        .await
        .unwrap();
    // Do not store transaction for uuid

    // Should assign 0 (since tracked tx does not exist, should break and assign current)
    let assigned = state.assign_next_nonce(&tx_uuid, &None).await.unwrap();
    assert_eq!(assigned, U256::from(0));
}

#[tokio::test]
async fn test_assign_next_nonce_all_taken_extends_upper() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        (*DOMAIN).clone(),
        nonce_db,
        tx_db,
        address,
        metrics,
    ));

    let tx_uuid = TransactionUuid::random();

    // Set finalized and upper nonce
    state.set_finalized_nonce(&U256::from(0)).await.unwrap();
    state.set_upper_nonce(&U256::from(3)).await.unwrap();

    // 0: tracked (Taken), 1: tracked (Taken), 2: tracked (Taken)
    for i in 0..3 {
        let uuid = TransactionUuid::random();
        state
            .set_tracked_tx_uuid(&U256::from(i), &uuid)
            .await
            .unwrap();
        let tx = create_tx(uuid, TransactionStatus::PendingInclusion);
        state.tx_db.store_transaction_by_uuid(&tx).await.unwrap();
    }

    // Should assign 3 (upper), and upper should be incremented to 4
    let assigned = state.assign_next_nonce(&tx_uuid, &None).await.unwrap();
    assert_eq!(assigned, U256::from(3));
    let upper = state.get_upper_nonce().await.unwrap();
    assert_eq!(upper, U256::from(4));
}
