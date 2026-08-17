use std::time::Duration;

use ethers_core::types::Address;
use hyperlane_core::U256;

use crate::adapter::chains::ethereum::nonce::tests::dummy_tx;
use crate::adapter::chains::ethereum::tests::MockEvmProvider;
use crate::adapter::AdaptsChain;
use crate::tests::evm::test_utils::mock_ethereum_adapter;
use crate::tests::test_utils::tmp_dbs;
use crate::{TransactionStatus, TransactionUuid};

#[tokio::test]
async fn test_other_boundary_refresh_cannot_consume_reorg_transition() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let mut provider = MockEvmProvider::new();
    provider
        .expect_get_next_nonce_on_finalized_block()
        .times(1)
        .returning(|_, _| Ok(U256::from(91)));
    let signer = Address::random();
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db,
        tx_db.clone(),
        nonce_db,
        signer,
        Duration::from_secs(60),
        Duration::from_millis(1),
    );
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce_test(&U256::from(100))
        .await
        .unwrap();
    let middle_tx_uuid = TransactionUuid::random();
    let middle_tx = dummy_tx(
        middle_tx_uuid.clone(),
        TransactionStatus::Finalized,
        Some(U256::from(95)),
        Some(signer),
    );
    tx_db.store_transaction_by_uuid(&middle_tx).await.unwrap();
    adapter
        .nonce_manager
        .state
        .set_tracked_tx_uuid_test(&U256::from(95), &middle_tx_uuid)
        .await
        .unwrap();
    let end_tx_uuid = TransactionUuid::random();
    let end_tx = dummy_tx(
        end_tx_uuid.clone(),
        TransactionStatus::Finalized,
        Some(U256::from(100)),
        Some(signer),
    );
    tx_db.store_transaction_by_uuid(&end_tx).await.unwrap();
    adapter
        .nonce_manager
        .state
        .set_tracked_tx_uuid_test(&U256::from(100), &end_tx_uuid)
        .await
        .unwrap();

    // This is the competing refresh that previously consumed the old/new transition.
    adapter.post_finalized().await.unwrap();
    let first_reprocess_txs = adapter.get_reprocess_txs().await.unwrap();
    let extended_finalized_nonce = U256::from(80);
    let (second_reprocess_txs, extended_range) = tokio::join!(
        adapter.get_reprocess_txs(),
        adapter
            .nonce_manager
            .state
            .update_boundary_nonces(&extended_finalized_nonce),
    );
    let second_reprocess_txs = second_reprocess_txs.unwrap();
    extended_range.unwrap();

    assert_eq!(first_reprocess_txs.len(), 2);
    assert_eq!(first_reprocess_txs[0].uuid, middle_tx_uuid);
    assert_eq!(first_reprocess_txs[1].uuid, end_tx_uuid);
    assert_eq!(second_reprocess_txs.len(), 2);
    assert_eq!(second_reprocess_txs[0].uuid, middle_tx_uuid);
    assert_eq!(second_reprocess_txs[1].uuid, end_tx_uuid);
    let retained_range = adapter
        .nonce_manager
        .state
        .get_reorged_nonce_range()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained_range.start, U256::from(81));
    assert_eq!(retained_range.end, U256::from(100));

    adapter
        .nonce_manager
        .state
        .update_boundary_nonces(&U256::from(100))
        .await
        .unwrap();
    assert!(adapter.get_reprocess_txs().await.unwrap().is_empty());
}
