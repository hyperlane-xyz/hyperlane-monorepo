use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ethers_core::abi::Function;
use ethers_core::types::Address;
use hyperlane_base::db::DbResult;
use hyperlane_core::U256;
use hyperlane_ethereum::EthereumReorgPeriod;
use mockall::mock;

use crate::adapter::EthereumTxPrecursor;
use crate::transaction::{Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData};
use crate::TransactionDropReason;

use super::super::super::tests::MockEvmProvider;
use super::super::super::transaction::Precursor;
use super::super::tests::MockNonceDb;
use super::NonceDb;
use super::NonceManager;
use super::NonceManagerState;
use super::NonceStatus;
use super::NonceUpdater;

#[allow(deprecated)]
fn make_tx(
    uuid: TransactionUuid,
    status: TransactionStatus,
    nonce: Option<U256>,
    address: Option<Address>,
) -> Transaction {
    let mut precursor = EthereumTxPrecursor {
        tx: Default::default(),
        function: Function {
            name: "".to_string(),
            inputs: vec![],
            outputs: vec![],
            constant: None,
            state_mutability: Default::default(),
        },
    };

    if let Some(n) = nonce {
        precursor.tx.set_nonce(n);
    }
    if let Some(addr) = address {
        precursor.tx.set_from(addr);
    }

    let tx = Transaction {
        uuid,
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Evm(precursor),
        payload_details: vec![],
        status,
        submission_attempts: 0,
        creation_timestamp: Default::default(),
        last_submission_attempt: None,
    };

    tx
}

fn init(mock_evm_provider: MockEvmProvider) -> (Arc<MockNonceDb>, Address, NonceManager) {
    let db = Arc::new(MockNonceDb::new());
    let address = Address::random();
    let state = Arc::new(NonceManagerState::new(db.clone(), address));

    let nonce_updater = NonceUpdater::new(
        address,
        EthereumReorgPeriod::Blocks(1),
        Duration::from_secs(12),
        Arc::new(mock_evm_provider),
        state.clone(),
    );

    let manager = NonceManager {
        address,
        state: state.clone(),
        nonce_updater,
    };

    (db, address, manager)
}

#[tokio::test]
async fn test_update_nonce_status_inserts_when_not_tracked() {
    let mock_evm_provider = MockEvmProvider::new();
    let (db, address, manager) = init(mock_evm_provider);

    let uuid = TransactionUuid::random();
    let nonce = U256::from(1);
    let tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        Some(nonce),
        Some(address),
    );

    // Not tracked: should insert
    manager.update_nonce_status(&tx, &tx.status).await.unwrap();
    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &address)
        .await
        .unwrap();
    assert!(matches!(status, Some(NonceStatus::Taken(u)) if u == uuid));
}

#[tokio::test]
async fn test_update_nonce_status_noop_when_same_status() {
    let mock_evm_provider = MockEvmProvider::new();
    let (db, address, manager) = init(mock_evm_provider);

    let uuid = TransactionUuid::random();
    let nonce = U256::from(2);
    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &address,
        &NonceStatus::Taken(uuid.clone()),
    )
    .await
    .unwrap();

    let tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        Some(nonce),
        Some(address),
    );

    // Should be noop (no error, no change)
    manager.update_nonce_status(&tx, &tx.status).await.unwrap();
    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &address)
        .await
        .unwrap();
    assert!(matches!(status, Some(NonceStatus::Taken(u)) if u == uuid));
}

#[tokio::test]
async fn test_update_nonce_status_freed_to_taken() {
    let mock_evm_provider = MockEvmProvider::new();
    let (db, address, manager) = init(mock_evm_provider);

    let uuid = TransactionUuid::random();
    let nonce = U256::from(3);
    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &address,
        &NonceStatus::Freed(uuid.clone()),
    )
    .await
    .unwrap();

    let tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        Some(nonce),
        Some(address),
    );

    // Freed -> Taken (should update)
    manager.update_nonce_status(&tx, &tx.status).await.unwrap();
    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &address)
        .await
        .unwrap();
    assert!(matches!(status, Some(NonceStatus::Taken(u)) if u == uuid));
}

#[tokio::test]
async fn test_update_nonce_status_same_tx_uuid_updates_status() {
    let mock_evm_provider = MockEvmProvider::new();
    let (db, address, manager) = init(mock_evm_provider);

    let uuid = TransactionUuid::random();
    let nonce = U256::from(4);
    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &address,
        &NonceStatus::Taken(uuid.clone()),
    )
    .await
    .unwrap();

    let tx = make_tx(
        uuid.clone(),
        TransactionStatus::Finalized,
        Some(nonce),
        Some(address),
    );

    // Taken -> Committed (same tx_uuid, should update)
    manager.update_nonce_status(&tx, &tx.status).await.unwrap();
    let status = db
        .retrieve_nonce_status_by_nonce_and_signer_address(&nonce, &address)
        .await
        .unwrap();
    assert!(matches!(status, Some(NonceStatus::Committed(u)) if u == uuid));
}

#[tokio::test]
async fn test_update_nonce_status_different_tx_uuid_errors() {
    let mock_evm_provider = MockEvmProvider::new();
    let (db, address, manager) = init(mock_evm_provider);

    let uuid1 = TransactionUuid::random();
    let uuid2 = TransactionUuid::random();
    let nonce = U256::from(5);
    db.store_nonce_status_by_nonce_and_signer_address(&nonce, &address, &NonceStatus::Taken(uuid1))
        .await
        .unwrap();

    let tx = make_tx(
        uuid2,
        TransactionStatus::PendingInclusion,
        Some(nonce),
        Some(address),
    );

    // Try to update to Taken with uuid2 (should error)
    let result = manager.update_nonce_status(&tx, &tx.status).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_assign_nonce_sets_nonce_when_none_present() {
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_evm_provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::one()));

    let (_, address, manager) = init(mock_evm_provider);

    let uuid = TransactionUuid::random();
    // No nonce set, but from address matches manager
    let mut tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        None,
        Some(address),
    );

    // Should assign nonce 0
    manager.assign_nonce(&mut tx).await.unwrap();
    let nonce: U256 = tx.precursor().tx.nonce().unwrap().into();
    assert_eq!(nonce, U256::one());
}

#[tokio::test]
async fn test_assign_nonce_noop_when_action_is_noop() {
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_evm_provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(1)));

    let (db, address, manager) = init(mock_evm_provider);

    let uuid = TransactionUuid::random();
    let nonce = U256::from(2);

    // Pre-store status so validate_assigned_nonce returns Noop
    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &address,
        &NonceStatus::Taken(uuid.clone()),
    )
    .await
    .unwrap();

    let mut tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        Some(nonce),
        Some(address),
    );

    // Should be a Noop, nonce remains unchanged
    manager.assign_nonce(&mut tx).await.unwrap();
    let tx_nonce: U256 = tx.precursor().tx.nonce().unwrap().into();
    assert_eq!(tx_nonce, nonce);
}

#[tokio::test]
async fn test_assign_nonce_assigns_when_action_is_assign() {
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_evm_provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(3)));

    let (db, address, manager) = init(mock_evm_provider);

    let uuid = TransactionUuid::random();
    let nonce = U256::from(2);

    // Pre-store status with different tx_uuid so validate_assigned_nonce returns Assign
    db.store_nonce_status_by_nonce_and_signer_address(
        &nonce,
        &address,
        &NonceStatus::Taken(TransactionUuid::random()),
    )
    .await
    .unwrap();

    let mut tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        Some(nonce),
        Some(address),
    );

    // Should assign the new nonce
    manager.assign_nonce(&mut tx).await.unwrap();
    let tx_nonce: U256 = tx.precursor().tx.nonce().unwrap().into();
    assert_eq!(tx_nonce, U256::from(3));
}

#[tokio::test]
async fn test_assign_nonce_error_when_from_address_missing() {
    let mock_evm_provider = MockEvmProvider::new();
    let (_, _, manager) = init(mock_evm_provider);

    let uuid = TransactionUuid::random();
    // None `from` address provided
    let mut tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        None,
        None,
    );

    let err = manager.assign_nonce(&mut tx).await.unwrap_err();
    assert!(err.to_string().contains("Transaction missing address"));
}

#[tokio::test]
async fn test_assign_nonce_error_when_from_address_mismatch() {
    let mock_evm_provider = MockEvmProvider::new();
    let (_, _, manager) = init(mock_evm_provider);
    let other_address = Address::random();

    let uuid = TransactionUuid::random();
    // From address does not match the manager address
    let mut tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        None,
        Some(other_address),
    );

    let err = manager.assign_nonce(&mut tx).await.unwrap_err();
    assert!(err
        .to_string()
        .contains("Transaction from address does not match nonce manager address"));
}
