use std::sync::Arc;
use std::time::Duration;

use ethers::abi::{Function, StateMutability};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::transaction::eip2930::AccessList;
use ethers::types::{Eip1559TransactionRequest, NameOrAddress, H160, U256 as EthersU256, U64};
use ethers_core::types::Address;

use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, U256};
use hyperlane_ethereum::EthereumReorgPeriod;

use crate::adapter::chains::ethereum::tests::{dummy_evm_tx, ExpectedTxType};
use crate::tests::evm::test_utils::mock_ethereum_adapter;
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{TransactionStatus, TransactionUuid};
use crate::FullPayload;

use super::super::super::tests::MockEvmProvider;
use super::super::super::transaction::Precursor;
use super::super::super::EthereumAdapterMetrics;
use super::super::tests::dummy_tx;
use super::super::updater::NonceUpdater;
use super::super::NonceManagerState;
use super::NonceManager;

fn make_nonce_updater(address: Address, state: Arc<NonceManagerState>) -> NonceUpdater {
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let block_time = Duration::from_secs(1);
    let provider = Arc::new(mock_provider());
    NonceUpdater::new(address, reorg_period, block_time, provider, state)
}

fn mock_provider() -> MockEvmProvider {
    let mut mock = MockEvmProvider::new();

    mock.expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::one()));

    mock
}

#[tokio::test]
async fn test_calculate_next_nonce_sets_nonce_when_none_present() {
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
    let tx = dummy_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        None,
        Some(address),
    );

    // Should assign nonce 1, since mock provider returns 1
    let nonce = manager.calculate_next_nonce(&tx).await.unwrap();
    assert_eq!(nonce, U256::one());
}

#[tokio::test]
async fn test_calculate_next_nonce_error_when_from_address_missing() {
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
    let tx = dummy_tx(
        uuid.clone(),
        TransactionStatus::PendingInclusion,
        None,
        None,
    );

    let err = manager.calculate_next_nonce(&tx).await.unwrap_err();
    assert!(err.to_string().contains("Transaction missing address"));
}

#[tokio::test]
async fn test_calculate_next_nonce_error_when_from_address_mismatch() {
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
    let tx = dummy_tx(
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

#[tokio::test]
async fn test_calculate_next_nonce_tx_and_db_equal() {
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

    let block_time = Duration::from_millis(100);

    let provider = Arc::new(provider);
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        nonce_db,
        tx_db,
        signer,
        metrics.clone(),
    ));

    let nonce_updater = NonceUpdater::new(
        signer,
        reorg_period,
        block_time,
        provider.clone(),
        state.clone(),
    );

    let nonce_manager = NonceManager {
        address: signer,
        state,
        nonce_updater,
    };

    let nonce_resp = nonce_manager
        .calculate_next_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    assert_eq!(nonce_resp, U256::from(nonce));
}

#[tokio::test]
async fn test_calculate_next_nonce_tx_and_db_mismatch() {
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
        .store_nonce_by_transaction_uuid(&signer, &tx.uuid, &U256::from(90))
        .await
        .expect("Failed to store tx nonce");

    let block_time = Duration::from_millis(100);

    let provider = Arc::new(provider);
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        nonce_db,
        tx_db,
        signer,
        metrics.clone(),
    ));

    let nonce_updater = NonceUpdater::new(
        signer,
        reorg_period,
        block_time,
        provider.clone(),
        state.clone(),
    );

    let nonce_manager = NonceManager {
        address: signer,
        state,
        nonce_updater,
    };

    let nonce_resp = nonce_manager
        .calculate_next_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    assert_eq!(nonce_resp, U256::from(90));
}

#[tokio::test]
async fn test_calculate_next_nonce_only_db_nonce() {
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
        .store_nonce_by_transaction_uuid(&signer, &tx.uuid, &U256::from(90))
        .await
        .expect("Failed to store tx nonce");

    let block_time = Duration::from_millis(100);

    let provider = Arc::new(provider);
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        nonce_db,
        tx_db,
        signer,
        metrics.clone(),
    ));

    let nonce_updater = NonceUpdater::new(
        signer,
        reorg_period,
        block_time,
        provider.clone(),
        state.clone(),
    );

    let nonce_manager = NonceManager {
        address: signer,
        state,
        nonce_updater,
    };

    let nonce_resp = nonce_manager
        .calculate_next_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    assert_eq!(nonce_resp, U256::from(90));
}

#[tokio::test]
async fn test_calculate_next_nonce_only_tx_nonce() {
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

    let block_time = Duration::from_millis(100);

    let provider = Arc::new(provider);
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        nonce_db,
        tx_db,
        signer,
        metrics.clone(),
    ));

    let nonce_updater = NonceUpdater::new(
        signer,
        reorg_period,
        block_time,
        provider.clone(),
        state.clone(),
    );

    let nonce_manager = NonceManager {
        address: signer,
        state,
        nonce_updater,
    };

    let nonce_resp = nonce_manager
        .calculate_next_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    assert_eq!(nonce_resp, U256::from(90));
}

#[tokio::test]
async fn test_calculate_next_nonce_db_nonce_max() {
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

    let precursor = tx.precursor_mut();
    precursor.tx.set_from(signer.clone());

    // Store U256::MAX in database - should be treated as None
    nonce_db
        .store_nonce_by_transaction_uuid(&signer, &tx.uuid, &U256::MAX)
        .await
        .expect("Failed to store tx nonce");

    let block_time = Duration::from_millis(100);

    let provider = Arc::new(provider);
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        nonce_db,
        tx_db,
        signer,
        metrics.clone(),
    ));

    let nonce_updater = NonceUpdater::new(
        signer,
        reorg_period,
        block_time,
        provider.clone(),
        state.clone(),
    );

    let nonce_manager = NonceManager {
        address: signer,
        state,
        nonce_updater,
    };

    let nonce_resp = nonce_manager
        .calculate_next_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    // Should get fresh nonce from provider since db has U256::MAX (treated as None)
    assert_eq!(nonce_resp, U256::from(100));
}

#[tokio::test]
async fn test_calculate_next_nonce_reassigns_outdated_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();

    let mut provider = MockEvmProvider::new();
    // Provider returns finalized nonce of 100
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(100)));

    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        vec![],
        crate::TransactionStatus::PendingInclusion,
        H160::random(),
    );

    let old_nonce = U256::from(50);
    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(old_nonce);
    precursor.tx.set_from(signer.clone());

    // Store old nonce in database
    nonce_db
        .store_nonce_by_transaction_uuid(&signer, &tx.uuid, &old_nonce)
        .await
        .expect("Failed to store tx nonce");

    // Set the old nonce as tracked
    nonce_db
        .store_transaction_uuid_by_nonce_and_signer_address(&old_nonce, &signer, &tx.uuid)
        .await
        .expect("Failed to store tx uuid");

    // Set finalized nonce above old_nonce (60 > 50)
    nonce_db
        .store_finalized_nonce_by_signer_address(&signer, &U256::from(60))
        .await
        .expect("Failed to store finalized nonce");

    let block_time = Duration::from_millis(100);

    let provider = Arc::new(provider);
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(
        nonce_db.clone(),
        tx_db,
        signer,
        metrics.clone(),
    ));

    let nonce_updater = NonceUpdater::new(
        signer,
        reorg_period,
        block_time,
        provider.clone(),
        state.clone(),
    );

    let nonce_manager = NonceManager {
        address: signer,
        state: state.clone(),
        nonce_updater,
    };

    let nonce_resp = nonce_manager
        .calculate_next_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    // Should get new nonce (100) since old nonce (50) is below finalized (60)
    assert_eq!(nonce_resp, U256::from(100));

    // Verify old nonce mapping is updated
    let tracked_uuid = nonce_db
        .retrieve_transaction_uuid_by_nonce_and_signer_address(&old_nonce, &signer)
        .await
        .expect("Failed to retrieve tracked uuid");

    // Old nonce should no longer be tracked (or tracked by a different tx)
    assert_ne!(tracked_uuid, Some(tx.uuid.clone()));

    // Verify new nonce is tracked
    let new_tracked_uuid = nonce_db
        .retrieve_transaction_uuid_by_nonce_and_signer_address(&nonce_resp, &signer)
        .await
        .expect("Failed to retrieve new tracked uuid");
    assert_eq!(new_tracked_uuid, Some(tx.uuid));
}
