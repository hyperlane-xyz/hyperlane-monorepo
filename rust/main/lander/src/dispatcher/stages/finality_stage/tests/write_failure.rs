use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use hyperlane_base::db::{DbError, DbResult, HyperlaneRocksDB, DB};
use hyperlane_core::KnownHyperlaneDomain;

use crate::{FullPayload, PayloadUuid, TransactionUuid};

use super::*;

struct FailSecondStatusWrite {
    inner: Arc<dyn PayloadDb>,
    status_writes: AtomicUsize,
}

#[async_trait]
impl PayloadDb for FailSecondStatusWrite {
    async fn retrieve_payload_by_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<FullPayload>> {
        self.inner.retrieve_payload_by_uuid(payload_uuid).await
    }

    async fn store_payload_by_uuid(&self, payload: &FullPayload) -> DbResult<()> {
        self.inner.store_payload_by_uuid(payload).await
    }

    async fn retrieve_payload_index_by_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<u32>> {
        self.inner
            .retrieve_payload_index_by_uuid(payload_uuid)
            .await
    }

    async fn store_payload_index_by_uuid(
        &self,
        index: u32,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<()> {
        self.inner
            .store_payload_index_by_uuid(index, payload_uuid)
            .await
    }

    async fn retrieve_payload_uuid_by_index(&self, index: u32) -> DbResult<Option<PayloadUuid>> {
        self.inner.retrieve_payload_uuid_by_index(index).await
    }

    async fn store_payload_uuid_by_index(
        &self,
        index: u32,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<()> {
        self.inner
            .store_payload_uuid_by_index(index, payload_uuid)
            .await
    }

    async fn store_highest_payload_index(&self, index: u32) -> DbResult<()> {
        self.inner.store_highest_payload_index(index).await
    }

    async fn retrieve_highest_payload_index(&self) -> DbResult<u32> {
        self.inner.retrieve_highest_payload_index().await
    }

    async fn retrieve_pending_payloads(&self) -> DbResult<Vec<FullPayload>> {
        self.inner.retrieve_pending_payloads().await
    }

    async fn pending_payload_index_checkpoint(&self) -> DbResult<Option<u64>> {
        self.inner.pending_payload_index_checkpoint().await
    }

    async fn pending_payload_index_requires_reconciliation(
        &self,
        checkpoint: u64,
    ) -> DbResult<bool> {
        self.inner
            .pending_payload_index_requires_reconciliation(checkpoint)
            .await
    }

    async fn mark_pending_payload_index_reconciled(&self) -> DbResult<()> {
        self.inner.mark_pending_payload_index_reconciled().await
    }

    async fn begin_pending_payload_index_reconciliation(&self) -> DbResult<()> {
        self.inner
            .begin_pending_payload_index_reconciliation()
            .await
    }

    async fn reconcile_pending_payloads(
        &self,
        first_index: u32,
        last_index: u32,
    ) -> DbResult<Vec<FullPayload>> {
        self.inner
            .reconcile_pending_payloads(first_index, last_index)
            .await
    }

    async fn store_new_payload_status(
        &self,
        payload_uuid: &PayloadUuid,
        new_status: PayloadStatus,
    ) -> DbResult<()> {
        if self.status_writes.fetch_add(1, Ordering::Relaxed) == 1 {
            return Err(DbError::Other(
                "injected second payload write failure".into(),
            ));
        }
        self.inner
            .store_new_payload_status(payload_uuid, new_status)
            .await
    }

    async fn store_tx_uuid_by_payload_uuid(
        &self,
        payload_uuid: &PayloadUuid,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<()> {
        self.inner
            .store_tx_uuid_by_payload_uuid(payload_uuid, tx_uuid)
            .await
    }

    async fn retrieve_tx_uuid_by_payload_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<TransactionUuid>> {
        self.inner
            .retrieve_tx_uuid_by_payload_uuid(payload_uuid)
            .await
    }
}

#[tokio::test]
async fn failed_payload_write_keeps_finalization_recoverable_without_counting_metrics() {
    let directory = tempfile::tempdir().unwrap();
    let domain = KnownHyperlaneDomain::Arbitrum.into();
    let db = Arc::new(HyperlaneRocksDB::new(
        &domain,
        DB::from_path(directory.path()).unwrap(),
    ));
    let payloads: Vec<_> = (0..2)
        .map(|_| {
            let mut payload = FullPayload::random();
            payload.status = PayloadStatus::InTransaction(TransactionStatus::Included);
            payload
        })
        .collect();
    for payload in &payloads {
        db.store_payload_by_uuid(payload).await.unwrap();
    }
    let tx = dummy_tx(payloads, TransactionStatus::Included);
    db.store_transaction_by_uuid(&tx).await.unwrap();
    let failing_payload_db = Arc::new(FailSecondStatusWrite {
        inner: db.clone(),
        status_writes: AtomicUsize::new(0),
    });
    let reverted = vec![tx.payload_details[0].clone()];
    let mut adapter = MockAdapter::new();
    adapter
        .expect_tx_status()
        .times(1)
        .returning(|_| Ok(TransactionStatus::Finalized));
    adapter
        .expect_reverted_payloads()
        .times(1)
        .withf(|tx| tx.status == TransactionStatus::Finalized)
        .returning(move |_| Ok(reverted.clone()));
    adapter.expect_post_finalized().times(0);
    let metrics = DispatcherMetrics::dummy_instance();
    let state = DispatcherState::new(
        failing_payload_db.clone(),
        db.clone(),
        Arc::new(adapter),
        metrics.clone(),
        "arbitrum".into(),
    );
    let pool = FinalityStagePool::new();
    pool.insert(tx.clone()).await;

    let error =
        FinalityStage::try_process_tx(tx.clone(), pool.clone(), BuildingStageQueue::new(), &state)
            .await
            .expect_err("a failed payload write must defer terminal transaction commit");
    assert!(error
        .to_string()
        .contains("injected second payload write failure"));
    assert_eq!(failing_payload_db.status_writes.load(Ordering::Relaxed), 2);
    assert!(pool.snapshot().await.contains_key(&tx.uuid));
    let persisted = db
        .retrieve_transaction_by_uuid(&tx.uuid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.status, TransactionStatus::Included);
    assert_payloads_status(
        vec![tx.payload_details[0].clone()],
        &state.payload_db,
        PayloadStatus::Dropped(PayloadDropReason::Reverted),
    )
    .await;
    assert_payloads_status(
        vec![tx.payload_details[1].clone()],
        &state.payload_db,
        PayloadStatus::InTransaction(TransactionStatus::Included),
    )
    .await;
    assert_eq!(
        metrics
            .finalized_transactions
            .with_label_values(&["arbitrum"])
            .get(),
        0
    );
    assert_eq!(
        metrics
            .dropped_payloads
            .with_label_values(&["arbitrum", "Reverted"])
            .get(),
        0
    );
    drop(state);

    // Retry the same durable Included transaction against the underlying RocksDB.
    let reverted = vec![tx.payload_details[0].clone()];
    let mut adapter = MockAdapter::new();
    adapter
        .expect_tx_status()
        .times(1)
        .returning(|_| Ok(TransactionStatus::Finalized));
    adapter
        .expect_reverted_payloads()
        .times(1)
        .withf(|tx| tx.status == TransactionStatus::Finalized)
        .returning(move |_| Ok(reverted.clone()));
    adapter
        .expect_post_finalized()
        .times(1)
        .returning(|| Ok(()));
    let state = DispatcherState::new(
        db.clone(),
        db.clone(),
        Arc::new(adapter),
        metrics.clone(),
        "arbitrum".into(),
    );
    FinalityStage::try_process_tx(persisted, pool.clone(), BuildingStageQueue::new(), &state)
        .await
        .unwrap();
    assert!(pool.snapshot().await.is_empty());
    assert_eq!(
        db.retrieve_transaction_by_uuid(&tx.uuid)
            .await
            .unwrap()
            .unwrap()
            .status,
        TransactionStatus::Finalized,
    );
    assert_payloads_status(
        vec![tx.payload_details[0].clone()],
        &state.payload_db,
        PayloadStatus::Dropped(PayloadDropReason::Reverted),
    )
    .await;
    assert_payloads_status(
        vec![tx.payload_details[1].clone()],
        &state.payload_db,
        PayloadStatus::InTransaction(TransactionStatus::Finalized),
    )
    .await;
    assert_eq!(
        metrics
            .finalized_transactions
            .with_label_values(&["arbitrum"])
            .get(),
        1
    );
    assert_eq!(
        metrics
            .dropped_payloads
            .with_label_values(&["arbitrum", "Reverted"])
            .get(),
        1
    );
}
