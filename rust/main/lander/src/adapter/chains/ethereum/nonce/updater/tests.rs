use std::sync::Arc;
use std::time::Duration;

use ethers_core::types::Address;

use hyperlane_core::{ChainCommunicationError, U256};
use hyperlane_ethereum::EthereumReorgPeriod;

use crate::tests::test_utils::tmp_dbs;
use crate::transaction::TransactionUuid;

use super::super::super::metrics::EthereumAdapterMetrics;
use super::super::super::tests::{MockEvmProvider, DOMAIN};
use super::super::state::NonceManagerState;
use super::super::updater::NonceUpdater;

fn make_updater(
    next_nonce: Option<U256>,
    should_fail: bool,
    state: Arc<NonceManagerState>,
    address: Address,
) -> NonceUpdater {
    let mut mock = MockEvmProvider::new();

    mock.expect_get_next_nonce_on_finalized_block()
        .returning(move |_, _| {
            if should_fail {
                Err(ChainCommunicationError::CustomError(
                    "ProviderError".to_string(),
                ))
            } else {
                Ok(next_nonce.unwrap_or(U256::zero()))
            }
        });

    let provider = Arc::new(mock);
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let block_time = Duration::from_millis(1);
    NonceUpdater::new(address, reorg_period, block_time, provider, state)
}

#[tokio::test]
async fn test_update_boundaries_immediately_success() {
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

    let updater = make_updater(Some(U256::from(5)), false, state.clone(), address);

    updater.update_boundaries_immediately().await.unwrap();

    // Should set finalized nonce to 4
    let finalized = state.get_finalized_nonce_test().await.unwrap();
    assert_eq!(finalized, Some(U256::from(4)));
}

#[tokio::test]
async fn test_update_boundaries_immediately_provider_error() {
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

    let updater = make_updater(None, true, state, address);

    let err = updater.update_boundaries_immediately().await.unwrap_err();
    assert!(err.to_string().contains("Provider error"));
}

#[tokio::test]
async fn test_update_boundaries_immediately_none_next_nonce() {
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

    // next_nonce = 0, so finalized_nonce = None, should not update
    let updater = make_updater(Some(U256::zero()), false, state.clone(), address);

    updater.update_boundaries_immediately().await.unwrap();

    // Should not set finalized nonce
    let finalized = state.get_finalized_nonce_test().await.unwrap();
    assert_eq!(finalized, None);
}

#[tokio::test]
async fn test_update_boundaries_waits_for_block_time() {
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

    let updater = make_updater(Some(U256::from(3)), false, state.clone(), address);

    // First call should update immediately
    updater.update_boundaries().await.unwrap();
    let finalized = state.get_finalized_nonce_test().await.unwrap();
    assert_eq!(finalized, Some(U256::from(2)));

    // Second call should NOT update because not enough time has passed
    state
        .set_finalized_nonce_test(&U256::from(100))
        .await
        .unwrap();
    updater.update_boundaries().await.unwrap();
    // Should still be 100, not overwritten
    let finalized = state.get_finalized_nonce_test().await.unwrap();
    assert_eq!(finalized, Some(U256::from(100)));

    // Wait for block_time and try again
    tokio::time::sleep(Duration::from_millis(2)).await;
    updater.update_boundaries().await.unwrap();
    // Should now be updated to 2 again
    let finalized = state.get_finalized_nonce_test().await.unwrap();
    assert_eq!(finalized, Some(U256::from(2)));
}
