use std::sync::Arc;
use std::time::Duration;

use ethers::types::{H160, U256 as EthersU256};
use ethers_core::types::Address;

use hyperlane_core::{HyperlaneDomain, U256};
use hyperlane_ethereum::EthereumReorgPeriod;

use crate::adapter::chains::ethereum::tests::{dummy_evm_tx, ExpectedTxType, MockEvmProvider};
use crate::adapter::chains::ethereum::Precursor;
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{DropReason, TransactionStatus, TransactionUuid};
use crate::TransactionDropReason;

use super::super::super::super::nonce::tests::make_tx;
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
    let tx = make_tx(
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
    let tx = make_tx(
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

    let tx = make_tx(
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
    let tx = make_tx(
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

    let tx = make_tx(
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

    let tx = make_tx(
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

    let tx = make_tx(
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

    let tx = make_tx(
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

    let tx = make_tx(
        uuid,
        TransactionStatus::PendingInclusion,
        None,
        Some(address),
    );

    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));
    // Set tracked_tx_uuid to uuid
    state.set_tracked_tx_uuid(&nonce, &tx.uuid).await.unwrap();

    let action = state.validate_assigned_nonce(&tx).await.unwrap();

    assert_eq!(action, NonceAction::Assign { nonce: nonce });
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 1);
}

#[tokio::test]
async fn test_validate_assigned_nonce_tx_and_db_equal() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();

    let mut provider = MockEvmProvider::new();
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(100)));

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

    nonce_db
        .store_transaction_uuid_by_nonce_and_signer_address(&U256::from(nonce), &signer, &tx.uuid)
        .await
        .expect("Failed to store tx uuid");
    nonce_db
        .store_finalized_nonce_by_signer_address(&signer, &U256::from(90))
        .await
        .expect("Failed to store nonce");
    nonce_db
        .store_nonce_by_transaction_uuid(&signer, &tx.uuid, &U256::from(nonce))
        .await
        .expect("Failed to store tx nonce");

    let metrics = EthereumAdapterMetrics::dummy_instance();
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

    assert_eq!(
        nonce_resp,
        NonceAction::Assign {
            nonce: nonce.into()
        }
    );
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 0);
}

#[tokio::test]
async fn test_validate_assigned_nonce_tx_and_db_mismatch() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();

    let mut provider = MockEvmProvider::new();
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(90)));

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

    nonce_db
        .store_transaction_uuid_by_nonce_and_signer_address(&U256::from(90), &signer, &tx.uuid)
        .await
        .expect("Failed to store tx uuid");
    nonce_db
        .store_finalized_nonce_by_signer_address(&signer, &U256::from(85))
        .await
        .expect("Failed to store nonce");
    nonce_db
        .store_nonce_by_transaction_uuid(&signer, &tx.uuid, &U256::from(90))
        .await
        .expect("Failed to store tx nonce");

    let metrics = EthereumAdapterMetrics::dummy_instance();
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

    assert_eq!(
        nonce_resp,
        NonceAction::Assign {
            nonce: U256::from(90)
        }
    );
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 1);
}

#[tokio::test]
async fn test_validate_assigned_nonce_only_db_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();

    let mut provider = MockEvmProvider::new();
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(90)));

    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::Included,
        H160::random(),
    );

    let precursor = tx.precursor_mut();
    precursor.tx.set_from(signer.clone());

    nonce_db
        .store_transaction_uuid_by_nonce_and_signer_address(&U256::from(90), &signer, &tx.uuid)
        .await
        .expect("Failed to store tx uuid");
    nonce_db
        .store_finalized_nonce_by_signer_address(&signer, &U256::from(85))
        .await
        .expect("Failed to store nonce");
    nonce_db
        .store_nonce_by_transaction_uuid(&signer, &tx.uuid, &U256::from(90))
        .await
        .expect("Failed to store tx nonce");

    let metrics = EthereumAdapterMetrics::dummy_instance();
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

    assert_eq!(
        nonce_resp,
        NonceAction::Assign {
            nonce: U256::from(90)
        }
    );
    assert_eq!(state.metrics.get_mismatched_nonce().get(), 1);
}

#[tokio::test]
async fn test_validate_assigned_nonce_only_tx_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();

    let mut provider = MockEvmProvider::new();
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(90)));

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

    let metrics = EthereumAdapterMetrics::dummy_instance();
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
