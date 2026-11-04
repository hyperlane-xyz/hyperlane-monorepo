use super::*;
use crate::tests::test_utils::persistence::{FailWrites, WriteKind};
use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_core::KnownHyperlaneDomain;

#[tokio::test(start_paused = true)]
async fn partial_build_writes_retry_the_same_transaction_before_handoff() {
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
        let tx = dummy_tx(vec![payload.clone()], TransactionStatus::PendingInclusion);
        let failing = Arc::new(FailWrites::new(db.clone(), kind));
        let (stage, mut receiver, _) =
            dummy_stage_receiver_queue(MockAdapter::new(), failing.clone(), failing);
        let built = TxBuildingResult {
            payloads: vec![payload.details],
            maybe_tx: Some(tx.clone()),
        };
        let handling = stage.handle_tx_building_result(&built);
        tokio::pin!(handling);
        assert!(
            futures_util::poll!(handling.as_mut()).is_pending(),
            "{kind:?} must pause the handoff"
        );
        assert!(receiver.try_recv().is_err());
        tokio::time::advance(std::time::Duration::from_secs(1)).await;
        handling.await.unwrap();
        assert_eq!(receiver.recv().await.unwrap(), tx);
        assert_eq!(db.retrieve_highest_transaction_index().await.unwrap(), 1);
        assert_eq!(
            db.retrieve_tx_uuid_by_payload_uuid(&tx.payload_details[0].uuid)
                .await
                .unwrap(),
            Some(tx.uuid.clone())
        );
    }
}

#[tokio::test]
async fn failed_build_verdict_write_requeues_payload_instead_of_losing_it() {
    let directory = tempfile::tempdir().unwrap();
    let db = Arc::new(HyperlaneRocksDB::new(
        &KnownHyperlaneDomain::Arbitrum.into(),
        DB::from_path(directory.path()).unwrap(),
    ));
    let payload = FullPayload::random();
    db.store_payload_by_uuid(&payload).await.unwrap();
    let failing = Arc::new(FailWrites::new(db.clone(), WriteKind::PayloadStatus));
    let mut adapter = MockAdapter::new();
    adapter
        .expect_build_transactions()
        .times(1)
        .returning(|payloads| {
            vec![TxBuildingResult {
                payloads: payloads.iter().map(|p| p.details.clone()).collect(),
                maybe_tx: None,
            }]
        });
    let (stage, mut receiver, queue) =
        dummy_stage_receiver_queue(adapter, failing.clone(), failing);
    stage.build_transactions(&vec![payload.clone()]).await;
    assert!(receiver.try_recv().is_err());
    assert_eq!(queue.pop_n(1).await, vec![payload]);
}
