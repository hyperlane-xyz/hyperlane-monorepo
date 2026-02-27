use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use ethers::types::Address;
use hyperlane_core::U256;

use crate::adapter::chains::ethereum::tests::{dummy_evm_tx, ExpectedTxType, MockEvmProvider};
use crate::adapter::AdaptsChain;
use crate::dispatcher::TransactionDb;
use crate::tests::evm::test_utils::mock_ethereum_adapter;
use crate::tests::test_utils::tmp_dbs;
use crate::{TransactionStatus, TransactionUuid};

async fn store_tracked_tx(
    adapter: &crate::adapter::chains::ethereum::EthereumAdapter,
    tx_db: &Arc<dyn TransactionDb>,
    nonce: u64,
) -> TransactionUuid {
    let tx_uuid = TransactionUuid::random();
    adapter
        .nonce_manager
        .state
        .set_tracked_tx_uuid_test(&U256::from(nonce), &tx_uuid)
        .await
        .unwrap();

    let mut tx = dummy_evm_tx(
        ExpectedTxType::Legacy,
        Vec::new(),
        TransactionStatus::Finalized,
        adapter.signer,
    );
    tx.uuid = tx_uuid.clone();
    tx_db.store_transaction_by_uuid(&tx).await.unwrap();
    tx_uuid
}

#[tokio::test]
async fn test_get_reprocess_txs_oversized_reorg_requires_manual_trigger() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let mut provider = MockEvmProvider::new();

    // old finalized nonce is set in DB to 200 below.
    // next nonce 100 => new finalized nonce 99, depth 101 (>25)
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(100)));

    let signer = Address::random();
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db,
        tx_db.clone(),
        nonce_db,
        signer,
        Duration::from_millis(100),
        Duration::from_millis(100),
    );

    adapter
        .nonce_manager
        .state
        .set_finalized_nonce_test(&U256::from(200))
        .await
        .unwrap();

    let expected_uuids = HashSet::from([
        store_tracked_tx(&adapter, &tx_db, 150).await,
        store_tracked_tx(&adapter, &tx_db, 151).await,
        store_tracked_tx(&adapter, &tx_db, 152).await,
    ]);

    let auto_reprocess_txs = adapter.get_reprocess_txs().await.unwrap();
    assert!(
        auto_reprocess_txs.is_empty(),
        "oversized reorg should skip automatic reprocessing"
    );

    let inspection = adapter.inspect_reorged_transactions().await.unwrap();
    assert!(inspection.manual_intervention_required);
    assert_eq!(inspection.old_finalized_nonce.as_deref(), Some("200"));
    assert_eq!(inspection.new_finalized_nonce.as_deref(), Some("99"));
    assert_eq!(inspection.transactions.len(), 3);

    let inspected_uuids: HashSet<_> = inspection
        .transactions
        .iter()
        .map(|tx| tx.uuid.clone())
        .collect();
    assert_eq!(inspected_uuids, expected_uuids);

    let queued = adapter
        .trigger_reprocess_reorged_transactions()
        .await
        .unwrap();
    assert_eq!(queued, 3);

    let manual_reprocess_txs = adapter.get_reprocess_txs().await.unwrap();
    assert_eq!(manual_reprocess_txs.len(), 3);
    let manual_uuids: HashSet<_> = manual_reprocess_txs
        .iter()
        .map(|tx| tx.uuid.clone())
        .collect();
    assert_eq!(manual_uuids, expected_uuids);

    let post_manual_inspection = adapter.inspect_reorged_transactions().await.unwrap();
    assert!(!post_manual_inspection.manual_intervention_required);
    assert!(post_manual_inspection.transactions.is_empty());
}

#[tokio::test]
async fn test_get_reprocess_txs_small_reorg_reprocesses_automatically() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let mut provider = MockEvmProvider::new();

    // old finalized nonce is set in DB to 50 below.
    // next nonce 41 => new finalized nonce 40, depth 10 (<=25)
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(41)));

    let signer = Address::random();
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db,
        tx_db.clone(),
        nonce_db,
        signer,
        Duration::from_millis(100),
        Duration::from_millis(100),
    );

    adapter
        .nonce_manager
        .state
        .set_finalized_nonce_test(&U256::from(50))
        .await
        .unwrap();

    let expected_uuids = HashSet::from([
        store_tracked_tx(&adapter, &tx_db, 41).await,
        store_tracked_tx(&adapter, &tx_db, 45).await,
    ]);

    let reprocess_txs = adapter.get_reprocess_txs().await.unwrap();
    assert_eq!(reprocess_txs.len(), 2);
    let actual_uuids: HashSet<_> = reprocess_txs.iter().map(|tx| tx.uuid.clone()).collect();
    assert_eq!(actual_uuids, expected_uuids);

    let inspection = adapter.inspect_reorged_transactions().await.unwrap();
    assert!(!inspection.manual_intervention_required);
    assert!(inspection.transactions.is_empty());
}
