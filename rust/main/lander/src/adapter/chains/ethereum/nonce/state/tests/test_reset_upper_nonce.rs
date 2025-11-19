use std::{sync::Arc, time::Duration};

use ethers::types::{Address, H160};

use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, U256};

use crate::{
    adapter::{
        chains::ethereum::{tests::MockEvmProvider, EthereumAdapterMetrics, NonceManagerState},
        AdaptsChain,
    },
    dispatcher::TransactionDb,
    tests::{evm::test_utils::mock_ethereum_adapter, test_utils::tmp_dbs},
    AdaptsChainAction, NonceDb, TransactionUuid,
};

use super::*;

fn mock_nonce_manager_state(
    tx_db: Arc<dyn TransactionDb>,
    nonce_db: Arc<dyn NonceDb>,
    signer: H160,
) -> NonceManagerState {
    let metrics = EthereumAdapterMetrics::dummy_instance();
    NonceManagerState::new(nonce_db, tx_db, signer, metrics.clone())
}

#[tokio::test]
async fn test_reset_upper_nonce_happy_path() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    // set up current upper and finalized nonce
    state.set_upper_nonce(&U256::from(150)).await.unwrap();
    state.set_finalized_nonce(&U256::from(90)).await.unwrap();

    let transactions = [
        (TransactionUuid::random(), U256::from(105)),
        (TransactionUuid::random(), U256::from(115)),
        (TransactionUuid::random(), U256::from(125)),
        (TransactionUuid::random(), U256::from(135)),
        (TransactionUuid::random(), U256::from(145)),
    ];
    for (tx_uuid, tx_nonce) in transactions.iter() {
        state
            .set_tracked_tx_uuid(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
    }

    assert!(state.reset_upper_nonce(Some(100)).await.is_ok());

    // check upper nonce has been updated
    let db_upper_nonce = state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(100));
    let db_finalized_nonce = state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(90)));

    // check transactions have been cleared
    for (tx_uuid, tx_nonce) in transactions.iter() {
        let db_tx_uuid = state
            .get_tracked_tx_uuid(tx_nonce)
            .await
            .expect("Failed to get tracked tx uuid");
        assert_eq!(db_tx_uuid, TransactionUuid::default());
        let db_tx_nonce = state
            .get_tx_nonce(tx_uuid)
            .await
            .expect("Failed to get tx nonce");
        assert_eq!(db_tx_nonce, Some(U256::MAX));
    }
}

#[tokio::test]
async fn test_higher_than_current_upper_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    state.set_upper_nonce(&U256::from(150)).await.unwrap();
    state.set_finalized_nonce(&U256::from(90)).await.unwrap();

    let transactions = [
        (TransactionUuid::random(), U256::from(105)),
        (TransactionUuid::random(), U256::from(115)),
        (TransactionUuid::random(), U256::from(125)),
        (TransactionUuid::random(), U256::from(135)),
        (TransactionUuid::random(), U256::from(145)),
    ];
    for (tx_uuid, tx_nonce) in transactions.iter() {
        state
            .set_tracked_tx_uuid(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
    }

    assert!(state.reset_upper_nonce(Some(200)).await.is_err());

    let db_upper_nonce = state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(150));
    let db_finalized_nonce = state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(90)));

    for (tx_uuid, tx_nonce) in transactions.iter() {
        let db_tx_uuid = state
            .get_tracked_tx_uuid(tx_nonce)
            .await
            .expect("Failed to get tracked tx uuid");
        assert_eq!(db_tx_uuid, tx_uuid.clone());
        let db_tx_nonce = state
            .get_tx_nonce(tx_uuid)
            .await
            .expect("Failed to get tx nonce");
        assert_eq!(db_tx_nonce, Some(tx_nonce.clone()));
    }
}

#[tokio::test]
async fn test_lower_than_current_finalized_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    state.set_upper_nonce(&U256::from(150)).await.unwrap();
    state.set_finalized_nonce(&U256::from(150)).await.unwrap();

    assert!(state.reset_upper_nonce(Some(100)).await.is_err());

    let db_upper_nonce = state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(150));
    let db_finalized_nonce = state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(150)));
}

#[tokio::test]
async fn test_set_to_finalized() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    state.set_upper_nonce(&U256::from(150)).await.unwrap();
    state.set_finalized_nonce(&U256::from(100)).await.unwrap();

    let transactions = [
        (TransactionUuid::random(), U256::from(105)),
        (TransactionUuid::random(), U256::from(115)),
        (TransactionUuid::random(), U256::from(125)),
        (TransactionUuid::random(), U256::from(135)),
        (TransactionUuid::random(), U256::from(145)),
    ];
    for (tx_uuid, tx_nonce) in transactions.iter() {
        state
            .set_tracked_tx_uuid(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
    }

    assert!(state.reset_upper_nonce(None).await.is_ok());

    let db_upper_nonce = state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(100));
    let db_finalized_nonce = state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(100)));

    for (tx_uuid, tx_nonce) in transactions.iter() {
        let db_tx_uuid = state
            .get_tracked_tx_uuid(tx_nonce)
            .await
            .expect("Failed to get tracked tx uuid");
        assert_eq!(db_tx_uuid, TransactionUuid::default());
        let db_tx_nonce = state
            .get_tx_nonce(tx_uuid)
            .await
            .expect("Failed to get tx nonce");
        assert_eq!(db_tx_nonce, Some(U256::MAX));
    }
}

#[tokio::test]
async fn test_missing_upper_nonce_in_db() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    state.set_finalized_nonce(&U256::from(100)).await.unwrap();

    assert!(state.reset_upper_nonce(Some(150)).await.is_err());

    let db_finalized_nonce = state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(100)));
}

#[tokio::test]
async fn test_missing_finalized_nonce_when_none_provided() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    state.set_upper_nonce(&U256::from(150)).await.unwrap();

    assert!(state.reset_upper_nonce(Some(120)).await.is_err());

    let db_finalized_nonce = state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_finalized_nonce, U256::from(150));
}

#[tokio::test]
async fn test_transaction_clearing_with_no_transactions() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    state.set_upper_nonce(&U256::from(150)).await.unwrap();
    state.set_finalized_nonce(&U256::from(90)).await.unwrap();

    assert!(state.reset_upper_nonce(Some(100)).await.is_ok());

    let db_upper_nonce = state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(100));
    let db_finalized_nonce = state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(90)));
}

#[tokio::test]
async fn test_consecutive_nonces_all_cleared() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    state.set_upper_nonce(&U256::from(110)).await.unwrap();
    state.set_finalized_nonce(&U256::from(90)).await.unwrap();

    // Create transactions at every nonce from 101 to 110
    let mut transactions = Vec::new();
    for nonce in 101..=110 {
        transactions.push((TransactionUuid::random(), U256::from(nonce)));
    }

    for (tx_uuid, tx_nonce) in transactions.iter() {
        state
            .set_tracked_tx_uuid(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
    }

    assert!(state.reset_upper_nonce(Some(100)).await.is_ok());

    let db_upper_nonce = state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(100));
    let db_finalized_nonce = state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(90)));

    for (tx_uuid, tx_nonce) in transactions.iter() {
        let db_tx_uuid = state
            .get_tracked_tx_uuid(tx_nonce)
            .await
            .expect("Failed to get tracked tx uuid");
        assert_eq!(db_tx_uuid, TransactionUuid::default());
        let db_tx_nonce = state
            .get_tx_nonce(tx_uuid)
            .await
            .expect("Failed to get tx nonce");
        assert_eq!(db_tx_nonce, Some(U256::MAX));
    }
}

#[tokio::test]
async fn test_equal_to_current_upper_nonce() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    state.set_upper_nonce(&U256::from(150)).await.unwrap();
    state.set_finalized_nonce(&U256::from(90)).await.unwrap();

    // Setting upper nonce equal to current upper nonce should fail
    assert!(state.reset_upper_nonce(Some(150)).await.is_err());

    let db_upper_nonce = state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(150));
}

#[tokio::test]
async fn test_boundary_finalized_plus_one() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    state.set_upper_nonce(&U256::from(150)).await.unwrap();
    state.set_finalized_nonce(&U256::from(100)).await.unwrap();

    // Setting upper nonce to finalized + 1 should succeed
    assert!(state.reset_upper_nonce(Some(101)).await.is_ok());

    let db_upper_nonce = state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(101));
}

#[tokio::test]
async fn test_partial_transaction_clearing() {
    let (_, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();
    let state = mock_nonce_manager_state(tx_db.clone(), nonce_db, signer);

    state.set_upper_nonce(&U256::from(150)).await.unwrap();
    state.set_finalized_nonce(&U256::from(90)).await.unwrap();

    // Create a sparse transaction map: transactions at some nonces but not all
    // Transactions at 105, 110, 115, 120, 125 but not 106-109, 111-114, etc.
    let transactions = [
        (TransactionUuid::random(), U256::from(105)),
        (TransactionUuid::random(), U256::from(110)),
        (TransactionUuid::random(), U256::from(115)),
        (TransactionUuid::random(), U256::from(120)),
        (TransactionUuid::random(), U256::from(125)),
    ];
    for (tx_uuid, tx_nonce) in transactions.iter() {
        state
            .set_tracked_tx_uuid(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
    }

    assert!(state.reset_upper_nonce(Some(100)).await.is_ok());

    let db_upper_nonce = state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(100));

    // All transactions in the range [101, 150] should be cleared
    for (tx_uuid, tx_nonce) in transactions.iter() {
        let db_tx_uuid = state
            .get_tracked_tx_uuid(tx_nonce)
            .await
            .expect("Failed to get tracked tx uuid");
        assert_eq!(db_tx_uuid, TransactionUuid::default());
        let db_tx_nonce = state
            .get_tx_nonce(tx_uuid)
            .await
            .expect("Failed to get tx nonce");
        assert_eq!(db_tx_nonce, Some(U256::MAX));
    }

    // Verify nonces without transactions were handled correctly (no panic)
    for nonce in [106, 111, 116, 121, 130, 140] {
        let db_tx_uuid = state
            .get_tracked_tx_uuid(&U256::from(nonce))
            .await
            .expect("Failed to get tracked tx uuid");
        assert_eq!(db_tx_uuid, TransactionUuid::default());
    }
}
