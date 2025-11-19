use std::{sync::Arc, time::Duration};

use ethers::types::Address;

use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, H160, U256};

use crate::{
    adapter::chains::ethereum::tests::MockEvmProvider,
    tests::{evm::test_utils::mock_ethereum_adapter, test_utils::tmp_dbs},
    TransactionUuid,
};

use super::*;

#[tokio::test]
async fn test_happy_path() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let provider = MockEvmProvider::new();

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    adapter
        .nonce_manager
        .state
        .set_upper_nonce(&U256::from(150))
        .await
        .unwrap();
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce(&U256::from(90))
        .await
        .unwrap();

    let transactions = [
        (TransactionUuid::random(), U256::from(105)),
        (TransactionUuid::random(), U256::from(115)),
        (TransactionUuid::random(), U256::from(125)),
        (TransactionUuid::random(), U256::from(135)),
        (TransactionUuid::random(), U256::from(145)),
    ];
    for (tx_uuid, tx_nonce) in transactions.iter() {
        adapter
            .nonce_manager
            .state
            .set_tracked_tx_uuid(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
    }

    assert!(adapter.set_upper_nonce(Some(100)).await.is_ok());

    let db_upper_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(100));
    let db_finalized_nonce = adapter
        .nonce_manager
        .state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(90)));
}

#[tokio::test]
async fn test_higher_than_current_upper_nonce() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let provider = MockEvmProvider::new();

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    adapter
        .nonce_manager
        .state
        .set_upper_nonce(&U256::from(150))
        .await
        .unwrap();
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce(&U256::from(90))
        .await
        .unwrap();

    let transactions = [
        (TransactionUuid::random(), U256::from(105)),
        (TransactionUuid::random(), U256::from(115)),
        (TransactionUuid::random(), U256::from(125)),
        (TransactionUuid::random(), U256::from(135)),
        (TransactionUuid::random(), U256::from(145)),
    ];
    for (tx_uuid, tx_nonce) in transactions.iter() {
        adapter
            .nonce_manager
            .state
            .set_tracked_tx_uuid(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
    }

    assert!(adapter.set_upper_nonce(Some(200)).await.is_err());

    let db_upper_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(150));
    let db_finalized_nonce = adapter
        .nonce_manager
        .state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(90)));

    for (tx_uuid, tx_nonce) in transactions.iter() {
        let db_tx_uuid = adapter
            .nonce_manager
            .state
            .get_tracked_tx_uuid(tx_nonce)
            .await
            .expect("Failed to get tracked tx uuid");
        assert_eq!(db_tx_uuid, tx_uuid.clone());
        let db_tx_nonce = adapter
            .nonce_manager
            .state
            .get_tx_nonce(tx_uuid)
            .await
            .expect("Failed to get tx nonce");
        assert_eq!(db_tx_nonce, Some(tx_nonce.clone()));
    }
}

#[tokio::test]
async fn test_lower_than_current_finalized_nonce() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let provider = MockEvmProvider::new();

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    adapter
        .nonce_manager
        .state
        .set_upper_nonce(&U256::from(150))
        .await
        .unwrap();
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce(&U256::from(150))
        .await
        .unwrap();

    assert!(adapter.set_upper_nonce(Some(100)).await.is_err());

    let db_upper_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(150));
    let db_finalized_nonce = adapter
        .nonce_manager
        .state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(150)));
}

#[tokio::test]
async fn test_set_to_finalized() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let provider = MockEvmProvider::new();

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    adapter
        .nonce_manager
        .state
        .set_upper_nonce(&U256::from(150))
        .await
        .unwrap();
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce(&U256::from(100))
        .await
        .unwrap();

    let transactions = [
        (TransactionUuid::random(), U256::from(105)),
        (TransactionUuid::random(), U256::from(115)),
        (TransactionUuid::random(), U256::from(125)),
        (TransactionUuid::random(), U256::from(135)),
        (TransactionUuid::random(), U256::from(145)),
    ];
    for (tx_uuid, tx_nonce) in transactions.iter() {
        adapter
            .nonce_manager
            .state
            .set_tracked_tx_uuid(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
    }

    assert!(adapter.set_upper_nonce(None).await.is_ok());

    let db_upper_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(100));
    let db_finalized_nonce = adapter
        .nonce_manager
        .state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(100)));

    for (tx_uuid, tx_nonce) in transactions.iter() {
        let db_tx_uuid = adapter
            .nonce_manager
            .state
            .get_tracked_tx_uuid(tx_nonce)
            .await
            .expect("Failed to get tracked tx uuid");
        assert_eq!(db_tx_uuid, TransactionUuid::default());
        let db_tx_nonce = adapter
            .nonce_manager
            .state
            .get_tx_nonce(tx_uuid)
            .await
            .expect("Failed to get tx nonce");
        assert_eq!(db_tx_nonce, Some(U256::MAX));
    }
}

#[tokio::test]
async fn test_missing_upper_nonce_in_db() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let provider = MockEvmProvider::new();

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    adapter
        .nonce_manager
        .state
        .set_finalized_nonce(&U256::from(100))
        .await
        .unwrap();

    assert!(adapter.set_upper_nonce(Some(150)).await.is_err());

    let db_finalized_nonce = adapter
        .nonce_manager
        .state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(100)));
}

#[tokio::test]
async fn test_missing_finalized_nonce_when_none_provided() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let provider = MockEvmProvider::new();

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    adapter
        .nonce_manager
        .state
        .set_upper_nonce(&U256::from(150))
        .await
        .unwrap();

    assert!(adapter.set_upper_nonce(Some(120)).await.is_err());

    let db_finalized_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_finalized_nonce, U256::from(150));
}

#[tokio::test]
async fn test_transaction_clearing_with_no_transactions() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let provider = MockEvmProvider::new();

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    adapter
        .nonce_manager
        .state
        .set_upper_nonce(&U256::from(150))
        .await
        .unwrap();
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce(&U256::from(90))
        .await
        .unwrap();

    assert!(adapter.set_upper_nonce(Some(100)).await.is_ok());

    let db_upper_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(100));
    let db_finalized_nonce = adapter
        .nonce_manager
        .state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(90)));
}

#[tokio::test]
async fn test_consecutive_nonces_all_cleared() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let provider = MockEvmProvider::new();

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    adapter
        .nonce_manager
        .state
        .set_upper_nonce(&U256::from(110))
        .await
        .unwrap();
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce(&U256::from(90))
        .await
        .unwrap();

    // Create transactions at every nonce from 101 to 110
    let mut transactions = Vec::new();
    for nonce in 101..=110 {
        transactions.push((TransactionUuid::random(), U256::from(nonce)));
    }

    for (tx_uuid, tx_nonce) in transactions.iter() {
        adapter
            .nonce_manager
            .state
            .set_tracked_tx_uuid(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
    }

    assert!(adapter.set_upper_nonce(Some(100)).await.is_ok());

    let db_upper_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce()
        .await
        .expect("Failed to retrieve upper nonce");
    assert_eq!(db_upper_nonce, U256::from(100));
    let db_finalized_nonce = adapter
        .nonce_manager
        .state
        .get_finalized_nonce()
        .await
        .expect("Failed to retrieve finalized nonce");
    assert_eq!(db_finalized_nonce, Some(U256::from(90)));

    for (tx_uuid, tx_nonce) in transactions.iter() {
        let db_tx_uuid = adapter
            .nonce_manager
            .state
            .get_tracked_tx_uuid(tx_nonce)
            .await
            .expect("Failed to get tracked tx uuid");
        assert_eq!(db_tx_uuid, TransactionUuid::default());
        let db_tx_nonce = adapter
            .nonce_manager
            .state
            .get_tx_nonce(tx_uuid)
            .await
            .expect("Failed to get tx nonce");
        assert_eq!(db_tx_nonce, Some(U256::MAX));
    }
}
