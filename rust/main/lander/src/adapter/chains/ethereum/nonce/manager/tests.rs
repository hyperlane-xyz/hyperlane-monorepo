use std::sync::Arc;
use std::time::Duration;

use ethers_core::types::Address;

use hyperlane_core::{HyperlaneDomain, U256};
use hyperlane_ethereum::EthereumReorgPeriod;

use crate::adapter::chains::ethereum::tests::{make_nonce_updater, make_tx};
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{TransactionStatus, TransactionUuid};

use super::super::super::tests::MockEvmProvider;
use super::super::super::transaction::Precursor;
use super::super::super::EthereumAdapterMetrics;
use super::super::updater::NonceUpdater;
use super::super::NonceManagerState;
use super::NonceManager;

#[tokio::test]
async fn test_assign_nonce_sets_nonce_when_none_present() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));
    let nonce_updater = make_nonce_updater(address, state.clone());
    let manager = NonceManager {
        address,
        state,
        nonce_updater,
    };

    let uuid = TransactionUuid::random();
    let tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        None,
        Some(address),
    );

    // Should assign nonce 1, since mock provider returns 1
    let nonce = manager.calculate_next_nonce(&tx).await.unwrap().unwrap();
    assert_eq!(nonce, U256::one());
}

#[tokio::test]
async fn test_assign_nonce_error_when_from_address_missing() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));
    let nonce_updater = make_nonce_updater(address, state.clone());
    let manager = NonceManager {
        address,
        state,
        nonce_updater,
    };

    let uuid = TransactionUuid::random();
    // Address is not set
    let tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        None,
        None,
    );

    let err = manager.calculate_next_nonce(&tx).await.unwrap_err();
    assert!(err.to_string().contains("Transaction missing address"));
}

#[tokio::test]
async fn test_assign_nonce_error_when_from_address_mismatch() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let address = Address::random();
    let other_address = Address::random();
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, address, metrics));
    let nonce_updater = make_nonce_updater(address, state.clone());
    let manager = NonceManager {
        address,
        state,
        nonce_updater,
    };

    let uuid = TransactionUuid::random();
    // From address does not match manager address
    let tx = make_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        None,
        Some(other_address),
    );

    let err = manager.calculate_next_nonce(&tx).await.unwrap_err();
    assert!(err
        .to_string()
        .contains("Transaction from address does not match nonce manager address"));
}
