use std::sync::Arc;

use ethers::types::{H160, U256 as EthersU256};
use ethers_core::types::Address;

use hyperlane_core::{HyperlaneDomain, U256};

use crate::adapter::chains::ethereum::tests::{dummy_evm_tx, ExpectedTxType};
use crate::adapter::chains::ethereum::Precursor;
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{DropReason, TransactionStatus, TransactionUuid};
use crate::TransactionDropReason;

use super::super::super::super::nonce::tests::dummy_tx;
use super::super::super::super::EthereumAdapterMetrics;
use super::NonceAction;
use super::NonceManagerState;

#[tokio::test]
async fn test_validate_assigned_nonce_none_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let tx = dummy_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        None,
        Some(address),
    );

    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    assert_eq!(action, NonceAction::AssignNext { old_nonce: None });
}

#[tokio::test]
async fn test_validate_assigned_nonce_not_tracked() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(1);
    let tx = dummy_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );

    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    assert_eq!(action, NonceAction::AssignNext { old_nonce: None });
}

#[tokio::test]
async fn test_validate_assigned_nonce_tracked_different_tx_uuid() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid1 = TransactionUuid::random();
    let uuid2 = TransactionUuid::random();
    let nonce_val = U256::from(2);

    // Set tracked_tx_uuid to uuid2
    state.set_tracked_tx_uuid(&nonce_val, &uuid2).await.unwrap();

    let tx = dummy_tx(
        uuid1,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    assert_eq!(action, NonceAction::AssignNext { old_nonce: None });
}

#[tokio::test]
async fn test_validate_assigned_nonce_freed_status() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(3);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // The transaction is Dropped, so nonce status is Freed
    let tx = dummy_tx(
        uuid,
        TransactionStatus::Dropped(DropReason::DroppedByChain),
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    assert_eq!(
        action,
        NonceAction::AssignNext {
            old_nonce: Some(nonce_val)
        }
    );
}

#[tokio::test]
async fn test_validate_assigned_nonce_taken_status_below_finalized() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(4);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // Set finalized nonce above nonce_val
    state.set_finalized_nonce(&(nonce_val + 1)).await.unwrap();

    let tx = dummy_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    assert_eq!(
        action,
        NonceAction::AssignNext {
            old_nonce: Some(nonce_val)
        }
    );
}

#[tokio::test]
async fn test_validate_assigned_nonce_taken_status_equal_finalized() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(5);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // Set finalized nonce equal to nonce_val
    state.set_finalized_nonce(&nonce_val).await.unwrap();

    let tx = dummy_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    assert_eq!(
        action,
        NonceAction::AssignNext {
            old_nonce: Some(nonce_val)
        }
    );
}

#[tokio::test]
async fn test_validate_assigned_nonce_taken_status_above_finalized() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(6);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // Set finalized nonce below nonce_val
    state.set_finalized_nonce(&(nonce_val - 1)).await.unwrap();

    let tx = dummy_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    assert_eq!(action, NonceAction::Assign { nonce: nonce_val });
}

#[tokio::test]
async fn test_validate_assigned_nonce_committed_status() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(7);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    let tx = dummy_tx(
        uuid,
        TransactionStatus::Finalized,
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    assert_eq!(action, NonceAction::Assign { nonce: nonce_val });
}

#[tokio::test]
async fn test_validate_assigned_nonce_with_db() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();

    let uuid = TransactionUuid::random();
    let nonce = U256::from(7);

    let tx = dummy_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        None,
        Some(address),
    );

    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));
    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce, &tx.uuid).await.unwrap();

    let action = state.validate_assigned_nonce(&tx).await.unwrap();

    assert_eq!(action, NonceAction::Assign { nonce });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 1);
}

#[tokio::test]
async fn test_validate_assigned_nonce_tx_and_db_equal() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();

    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    let nonce = U256::from(100);
    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(nonce);
    precursor.tx.set_from(signer.clone());

    nonce_db
        .store_finalized_nonce_by_signer_address(&signer, &U256::from(90))
        .await
        .expect("Failed to store nonce");

    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        nonce_db,
        tx_db,
        signer,
        metrics.clone(),
    ));
    state.set_tracked_tx_uuid(&nonce, &tx.uuid).await.unwrap();

    let nonce_resp = state
        .validate_assigned_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    assert_eq!(nonce_resp, NonceAction::Assign { nonce });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 0);
}

#[tokio::test]
async fn test_validate_assigned_nonce_tx_and_db_mismatch() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();

    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(EthersU256::from(100));
    precursor.tx.set_from(signer.clone());

    nonce_db
        .store_finalized_nonce_by_signer_address(&signer, &U256::from(85))
        .await
        .expect("Failed to store nonce");

    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        nonce_db,
        tx_db,
        signer,
        metrics.clone(),
    ));
    let nonce = U256::from(90);
    state.set_tracked_tx_uuid(&nonce, &tx.uuid).await.unwrap();

    let nonce_resp = state
        .validate_assigned_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    assert_eq!(nonce_resp, NonceAction::Assign { nonce });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 1);
}

#[tokio::test]
async fn test_validate_assigned_nonce_only_db_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();

    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    // leaving nonce empty in the transaction as test case
    let precursor = tx.precursor_mut();
    precursor.tx.set_from(signer.clone());

    nonce_db
        .store_finalized_nonce_by_signer_address(&signer, &U256::from(85))
        .await
        .expect("Failed to store nonce");

    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        nonce_db,
        tx_db,
        signer,
        metrics.clone(),
    ));
    let nonce = U256::from(90);
    state.set_tracked_tx_uuid(&nonce, &tx.uuid).await.unwrap();

    let nonce_resp = state
        .validate_assigned_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    assert_eq!(nonce_resp, NonceAction::Assign { nonce });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 1);
}

#[tokio::test]
async fn test_validate_assigned_nonce_only_tx_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let signer = Address::random();

    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    let nonce = EthersU256::from(100);
    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(nonce);
    precursor.tx.set_from(signer.clone());

    let state = Arc::new(NonceManagerState::new(
        nonce_db,
        tx_db,
        signer,
        metrics.clone(),
    ));

    let nonce_resp = state
        .validate_assigned_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    assert_eq!(nonce_resp, NonceAction::AssignNext { old_nonce: None });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 1);
}

#[tokio::test]
async fn test_validate_assigned_nonce_db_nonce_max() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let address = Address::random();

    let uuid = TransactionUuid::random();
    // Store U256::MAX in the database - should be treated as None
    nonce_db
        .store_nonce_by_transaction_uuid(&address, &uuid, &U256::MAX)
        .await
        .expect("Failed to store nonce");

    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let tx = dummy_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        None,
        Some(address),
    );

    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    // U256::MAX should be treated as None, so we should assign next
    assert_eq!(action, NonceAction::AssignNext { old_nonce: None });
    // should not alert mismatch nonce because both tx and db is None (or treated as None)
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 0);
}

#[tokio::test]
async fn test_validate_assigned_nonce_db_nonce_max_tx_nonce_some() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let address = Address::random();

    let uuid = TransactionUuid::random();
    // Store U256::MAX in the database - should be treated as None
    nonce_db
        .store_nonce_by_transaction_uuid(&address, &uuid, &U256::MAX)
        .await
        .expect("Failed to store nonce");

    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let tx = dummy_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(U256::from(100)),
        Some(address),
    );

    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    // U256::MAX should be treated as None, so we should assign next
    assert_eq!(action, NonceAction::AssignNext { old_nonce: None });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 1);
}

#[tokio::test]
async fn test_validate_assigned_nonce_taken_status_no_finalized() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(8);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // Do NOT set finalized_nonce (it will be None)

    let tx = dummy_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    // With no finalized nonce, Taken status should just assign the nonce
    assert_eq!(action, NonceAction::Assign { nonce: nonce_val });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 0);
}

#[tokio::test]
async fn test_validate_assigned_nonce_freed_status_failed_simulation() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(9);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // The transaction is Dropped with FailedSimulation, so nonce status is Freed
    let tx = dummy_tx(
        uuid,
        TransactionStatus::Dropped(DropReason::FailedSimulation),
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    assert_eq!(
        action,
        NonceAction::AssignNext {
            old_nonce: Some(nonce_val)
        }
    );
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 0);
}

#[tokio::test]
async fn test_validate_assigned_nonce_mempool_status() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(10);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // Set finalized nonce below nonce_val
    state.set_finalized_nonce(&(nonce_val - 1)).await.unwrap();

    let tx = dummy_tx(
        uuid,
        TransactionStatus::Mempool,
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    // Mempool maps to Taken status, above finalized nonce -> Assign
    assert_eq!(action, NonceAction::Assign { nonce: nonce_val });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 0);
}

#[tokio::test]
async fn test_validate_assigned_nonce_included_status() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(11);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // Set finalized nonce below nonce_val
    state.set_finalized_nonce(&(nonce_val - 1)).await.unwrap();

    let tx = dummy_tx(
        uuid,
        TransactionStatus::Included,
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    // Included maps to Taken status, above finalized nonce -> Assign
    assert_eq!(action, NonceAction::Assign { nonce: nonce_val });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 0);
}

#[tokio::test]
async fn test_validate_assigned_nonce_committed_below_finalized() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(12);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // Set finalized nonce above nonce_val
    state.set_finalized_nonce(&(nonce_val + 1)).await.unwrap();

    let tx = dummy_tx(
        uuid,
        TransactionStatus::Finalized,
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    // Committed status doesn't check finalized nonce, always returns Assign
    assert_eq!(action, NonceAction::Assign { nonce: nonce_val });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 0);
}

#[tokio::test]
async fn test_validate_assigned_nonce_zero_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));

    let uuid = TransactionUuid::random();
    let nonce_val = U256::from(0);

    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce_val, &uuid).await.unwrap();

    // No finalized nonce set

    let tx = dummy_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        Some(nonce_val),
        Some(address),
    );
    let action = state.validate_assigned_nonce(&tx).await.unwrap();
    // Zero nonce should work just like any other nonce
    assert_eq!(action, NonceAction::Assign { nonce: nonce_val });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 0);
}
