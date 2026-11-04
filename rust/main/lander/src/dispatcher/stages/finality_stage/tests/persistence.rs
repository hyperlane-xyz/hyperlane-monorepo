use super::*;
use crate::dispatcher::{LoadableFromDb, PayloadDbLoader, TransactionDbLoader};
use crate::tests::test_utils::persistence::{FailWrites, WriteKind};
use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_core::KnownHyperlaneDomain;

#[tokio::test]
async fn partial_reorg_requeue_writes_recover_before_rebuilding_payloads() {
    for kind in [
        WriteKind::Transaction,
        WriteKind::PayloadStatus,
        WriteKind::Association,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(HyperlaneRocksDB::new(
            &KnownHyperlaneDomain::Arbitrum.into(),
            DB::from_path(directory.path()).unwrap(),
        ));
        let mut payload = FullPayload::random();
        payload.status = PayloadStatus::InTransaction(TransactionStatus::Included);
        db.store_payload_by_uuid(&payload).await.unwrap();
        let tx = dummy_tx(vec![payload.clone()], TransactionStatus::Included);
        db.store_transaction_by_uuid(&tx).await.unwrap();
        db.store_tx_uuid_by_payload_uuid(&payload.details.uuid, &tx.uuid)
            .await
            .unwrap();
        let failing = Arc::new(FailWrites::new(db.clone(), kind));
        let state = DispatcherState::new(
            failing.clone(),
            failing,
            Arc::new(MockAdapter::new()),
            DispatcherMetrics::dummy_instance(),
            "arbitrum".into(),
        );
        let pool = FinalityStagePool::new();
        pool.insert(tx.clone()).await;
        let queue = BuildingStageQueue::new();
        assert!(FinalityStage::handle_dropped_transaction(
            tx.clone(),
            TxDropReason::DroppedByChain,
            queue.clone(),
            &state,
            pool.clone()
        )
        .await
        .is_err());
        assert!(pool.snapshot().await.contains_key(&tx.uuid));
        assert_eq!(queue.len().await, 0);
        assert_eq!(
            db.retrieve_transaction_by_uuid(&tx.uuid)
                .await
                .unwrap()
                .unwrap()
                .status,
            TransactionStatus::Included
        );
        // Reopening/recovering the durable Included marker repairs any Ready
        // payload or detached association before the pending index is loaded.
        let (inclusion_sender, _) = mpsc::channel(1);
        let (finality_sender, mut finality_receiver) = mpsc::channel(1);
        let loader = TransactionDbLoader::new(
            state.clone(),
            inclusion_sender,
            finality_sender,
            "arbitrum".into(),
        );
        loader.load(tx.clone()).await.unwrap();
        assert_eq!(finality_receiver.recv().await.unwrap().uuid, tx.uuid);
        PayloadDbLoader::new(state.payload_db.clone(), queue.clone(), "arbitrum".into())
            .load_from_db(state.metrics.clone())
            .await
            .unwrap();
        assert_eq!(queue.len().await, 0);
        assert_eq!(
            db.retrieve_tx_uuid_by_payload_uuid(&payload.details.uuid)
                .await
                .unwrap(),
            Some(tx.uuid.clone())
        );
        FinalityStage::handle_dropped_transaction(
            tx.clone(),
            TxDropReason::DroppedByChain,
            queue.clone(),
            &state,
            pool.clone(),
        )
        .await
        .unwrap();
        assert_eq!(queue.len().await, 1);
        assert!(!pool.snapshot().await.contains_key(&tx.uuid));
        assert_eq!(db.retrieve_pending_payloads().await.unwrap().len(), 1);
        assert_eq!(
            db.retrieve_tx_uuid_by_payload_uuid(&payload.details.uuid)
                .await
                .unwrap(),
            Some(TransactionUuid::default())
        );
    }
}

#[tokio::test]
async fn failed_final_commit_keeps_original_status_for_retry() {
    for kind in [WriteKind::Transaction, WriteKind::PayloadStatus] {
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(HyperlaneRocksDB::new(
            &KnownHyperlaneDomain::Arbitrum.into(),
            DB::from_path(directory.path()).unwrap(),
        ));
        let mut payload = FullPayload::random();
        payload.status = PayloadStatus::InTransaction(TransactionStatus::Included);
        db.store_payload_by_uuid(&payload).await.unwrap();
        let mut tx = dummy_tx(vec![payload], TransactionStatus::Included);
        db.store_transaction_by_uuid(&tx).await.unwrap();
        let failing = Arc::new(FailWrites::new(db.clone(), kind));
        let mut adapter = MockAdapter::new();
        adapter.expect_reverted_payloads().returning(|_| Ok(vec![]));
        adapter.expect_post_finalized().returning(|| Ok(()));
        let state = DispatcherState::new(
            failing.clone(),
            failing,
            Arc::new(adapter),
            DispatcherMetrics::dummy_instance(),
            "arbitrum".into(),
        );
        assert!(FinalityStage::finalize_transaction(&mut tx, &state)
            .await
            .is_err());
        assert_eq!(tx.status, TransactionStatus::Included);
        assert_eq!(
            db.retrieve_transaction_by_uuid(&tx.uuid)
                .await
                .unwrap()
                .unwrap()
                .status,
            TransactionStatus::Included
        );
        FinalityStage::finalize_transaction(&mut tx, &state)
            .await
            .unwrap();
        assert_eq!(tx.status, TransactionStatus::Finalized);
        assert_eq!(
            db.retrieve_transaction_by_uuid(&tx.uuid)
                .await
                .unwrap()
                .unwrap()
                .status,
            TransactionStatus::Finalized
        );
    }
}
