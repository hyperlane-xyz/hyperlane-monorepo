use super::*;
use crate::tests::test_utils::persistence::{FailWrites, WriteKind};
use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_core::KnownHyperlaneDomain;
use tokio::sync::Mutex;

#[tokio::test]
async fn failed_inclusion_handoff_writes_retain_pool_ownership() {
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
        let payload = FullPayload::random();
        db.store_payload_by_uuid(&payload).await.unwrap();
        let tx = dummy_tx(vec![payload], TransactionStatus::PendingInclusion);
        db.store_transaction_by_uuid(&tx).await.unwrap();
        let failing = Arc::new(FailWrites::new(db.clone(), kind));
        let state = DispatcherState::new(
            failing.clone(),
            failing,
            Arc::new(MockAdapter::new()),
            DispatcherMetrics::dummy_instance(),
            "arbitrum".into(),
        );
        let pool = Arc::new(Mutex::new(std::collections::HashMap::from([(
            tx.uuid.clone(),
            tx.clone(),
        )])));
        let (sender, mut receiver) = mpsc::channel(1);
        assert!(InclusionStage::try_process_tx_with_next_status(
            tx.clone(),
            TransactionStatus::Included,
            &sender,
            &state,
            &pool,
            "arbitrum"
        )
        .await
        .is_err());
        assert_eq!(pool.lock().await.get(&tx.uuid), Some(&tx));
        assert!(receiver.try_recv().is_err());
        InclusionStage::try_process_tx_with_next_status(
            tx.clone(),
            TransactionStatus::Included,
            &sender,
            &state,
            &pool,
            "arbitrum",
        )
        .await
        .unwrap();
        assert_eq!(
            receiver.recv().await.unwrap().status,
            TransactionStatus::Included
        );
        assert!(!pool.lock().await.contains_key(&tx.uuid));
    }
}

#[tokio::test]
async fn failed_drop_writes_restore_local_status_and_keep_transaction_recoverable() {
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
        let payload = FullPayload::random();
        db.store_payload_by_uuid(&payload).await.unwrap();
        let mut tx = dummy_tx(vec![payload], TransactionStatus::Mempool);
        db.store_transaction_by_uuid(&tx).await.unwrap();
        let failing = Arc::new(FailWrites::new(db.clone(), kind));
        let state = DispatcherState::new(
            failing.clone(),
            failing,
            Arc::new(MockAdapter::new()),
            DispatcherMetrics::dummy_instance(),
            "arbitrum".into(),
        );
        let pool = Arc::new(Mutex::new(std::collections::HashMap::from([(
            tx.uuid.clone(),
            tx.clone(),
        )])));
        assert!(
            InclusionStage::drop_tx(&state, &mut tx, TxDropReason::FailedSimulation, &pool)
                .await
                .is_err()
        );
        assert_eq!(tx.status, TransactionStatus::Mempool);
        assert_eq!(pool.lock().await.get(&tx.uuid), Some(&tx));
        assert_eq!(
            db.retrieve_transaction_by_uuid(&tx.uuid)
                .await
                .unwrap()
                .unwrap()
                .status,
            TransactionStatus::Mempool
        );
        InclusionStage::drop_tx(&state, &mut tx, TxDropReason::FailedSimulation, &pool)
            .await
            .unwrap();
        assert!(!pool.lock().await.contains_key(&tx.uuid));
    }
}

#[tokio::test(start_paused = true)]
async fn submitted_hashes_are_retained_until_storage_recovers_without_rebroadcast() {
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
        let payload = FullPayload::random();
        db.store_payload_by_uuid(&payload).await.unwrap();
        let tx = dummy_tx(vec![payload], TransactionStatus::PendingInclusion);
        db.store_transaction_by_uuid(&tx).await.unwrap();
        let failing = Arc::new(FailWrites::new(db.clone(), kind));
        let hash = hyperlane_core::H512::repeat_byte(7);
        let mut adapter = MockAdapter::new();
        adapter
            .expect_simulate_tx()
            .times(1)
            .returning(|_| Ok(vec![]));
        adapter.expect_estimate_tx().times(1).returning(|_| Ok(()));
        adapter.expect_submit().times(1).returning(move |tx| {
            tx.tx_hashes.push(hash);
            Ok(())
        });
        adapter
            .expect_update_vm_specific_metrics()
            .times(1)
            .return_const(());
        let state = DispatcherState::new(
            failing.clone(),
            failing,
            Arc::new(adapter),
            DispatcherMetrics::dummy_instance(),
            "arbitrum".into(),
        );
        let pool = Arc::new(Mutex::new(std::collections::HashMap::from([(
            tx.uuid.clone(),
            tx.clone(),
        )])));
        let processing = InclusionStage::process_pending_tx(tx.clone(), &state, &pool, "arbitrum");
        tokio::pin!(processing);
        assert!(futures_util::poll!(processing.as_mut()).is_pending());
        assert!(pool.lock().await.contains_key(&tx.uuid));
        tokio::time::advance(Duration::from_secs(1)).await;
        processing.await.unwrap();
        let persisted = db
            .retrieve_transaction_by_uuid(&tx.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted.tx_hashes, vec![hash]);
        assert_eq!(persisted.submission_attempts, 1);
        assert_eq!(persisted.status, TransactionStatus::Mempool);
        assert_eq!(pool.lock().await.get(&tx.uuid), Some(&persisted));
    }
}
