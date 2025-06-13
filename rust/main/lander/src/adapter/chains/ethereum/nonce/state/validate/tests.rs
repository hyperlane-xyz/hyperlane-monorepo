use std::sync::Arc;

use ethers_core::types::Address;

use hyperlane_core::{HyperlaneDomain, U256};

use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{DropReason, TransactionStatus, TransactionUuid};
use crate::TransactionDropReason;

use super::super::super::super::nonce::tests::make_tx;
use super::super::super::super::tests::DOMAIN;
use super::super::super::super::EthereumAdapterMetrics;
use super::NonceAction;
use super::NonceManagerState;

#[tokio::test]
async fn test_validate_assigned_nonce_none_nonce() {
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

    let uuid = TransactionUuid::random();
    let tx = make_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        None,
        Some(address),
    );

    let (action, nonce) = state.validate_assigned_nonce(&tx).await.unwrap();
    assert!(matches!(action, NonceAction::Assign));
    assert_eq!(nonce, None);
}

#[tokio::test]
async fn test_validate_assigned_nonce_not_tracked() {
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

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(1);
    let tx = make_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );

    let (action, nonce) = state.validate_assigned_nonce(&tx).await.unwrap();
    assert!(matches!(action, NonceAction::Assign));
    assert_eq!(nonce, Some(nonce_val));
}

#[tokio::test]
async fn test_validate_assigned_nonce_tracked_different_tx_uuid() {
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

    let uuid1 = TransactionUuid::random();
    let uuid2 = TransactionUuid::random();
    let nonce_val = U256::from(2);

    // Set tracked_tx_uuid to uuid2
    state.set_tracked_tx_uuid(&nonce_val, &uuid2).await.unwrap();

    let tx = make_tx(
        uuid1,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );
    let (action, nonce) = state.validate_assigned_nonce(&tx).await.unwrap();
    assert!(matches!(action, NonceAction::Assign));
    assert_eq!(nonce, Some(nonce_val));
}

#[tokio::test]
async fn test_validate_assigned_nonce_freed_status() {
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

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(3);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // The transaction is Dropped, so nonce status is Freed
    let tx = make_tx(
        uuid,
        TransactionStatus::Dropped(DropReason::DroppedByChain),
        Some(nonce_val),
        Some(address),
    );
    let (action, nonce) = state.validate_assigned_nonce(&tx).await.unwrap();
    assert!(matches!(action, NonceAction::Assign));
    assert_eq!(nonce, Some(nonce_val));
}

#[tokio::test]
async fn test_validate_assigned_nonce_taken_status_below_finalized() {
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

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(4);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // Set finalized nonce above nonce_val
    state.set_finalized_nonce(&(nonce_val + 1)).await.unwrap();

    let tx = make_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );
    let (action, nonce) = state.validate_assigned_nonce(&tx).await.unwrap();
    assert!(matches!(action, NonceAction::Assign));
    assert_eq!(nonce, Some(nonce_val));
}

#[tokio::test]
async fn test_validate_assigned_nonce_taken_status_equal_finalized() {
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

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(5);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // Set finalized nonce equal to nonce_val
    state.set_finalized_nonce(&nonce_val).await.unwrap();

    let tx = make_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );
    let (action, nonce) = state.validate_assigned_nonce(&tx).await.unwrap();
    assert!(matches!(action, NonceAction::Assign));
    assert_eq!(nonce, Some(nonce_val));
}

#[tokio::test]
async fn test_validate_assigned_nonce_taken_status_above_finalized() {
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

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(6);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // Set finalized nonce below nonce_val
    state.set_finalized_nonce(&(nonce_val - 1)).await.unwrap();

    let tx = make_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );
    let (action, nonce) = state.validate_assigned_nonce(&tx).await.unwrap();
    assert!(matches!(action, NonceAction::Noop));
    assert_eq!(nonce, Some(nonce_val));
}

#[tokio::test]
async fn test_validate_assigned_nonce_committed_status() {
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

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(7);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    let tx = make_tx(
        uuid,
        TransactionStatus::Finalized,
        Some(nonce_val),
        Some(address),
    );
    let (action, nonce) = state.validate_assigned_nonce(&tx).await.unwrap();
    assert!(matches!(action, NonceAction::Noop));
    assert_eq!(nonce, Some(nonce_val));
}
