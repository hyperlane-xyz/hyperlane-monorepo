use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::Semaphore;

use crate::adapter::{AdaptsChain, GasLimit, TxBuildingResult};
use crate::dispatcher::{DispatcherMetrics, DispatcherState};
use crate::tests::test_utils::{dummy_tx, tmp_dbs};
use crate::transaction::{Transaction, TransactionStatus, TransactionUuid};
use crate::{FullPayload, LanderError};
use hyperlane_core::H512;

use super::{read_transaction_status_batch, FinalizedStatusRead};

#[derive(Default)]
struct BatchAdapter {
    calls: Mutex<Vec<Vec<(TransactionUuid, usize)>>>,
    gate: Option<Arc<Semaphore>>,
    wrong_count: bool,
}

#[async_trait]
impl AdaptsChain for BatchAdapter {
    async fn estimate_gas_limit(&self, _: &FullPayload) -> Result<Option<GasLimit>, LanderError> {
        unimplemented!()
    }
    async fn build_transactions(&self, _: &[FullPayload]) -> Vec<TxBuildingResult> {
        unimplemented!()
    }
    async fn estimate_tx(&self, _: &mut Transaction) -> Result<(), LanderError> {
        unimplemented!()
    }
    async fn submit(&self, _: &mut Transaction) -> Result<(), LanderError> {
        unimplemented!()
    }
    async fn get_tx_hash_status(&self, _: H512) -> Result<TransactionStatus, LanderError> {
        unimplemented!()
    }
    fn estimated_block_time(&self) -> &Duration {
        unimplemented!()
    }
    fn update_vm_specific_metrics(&self, _: &Transaction, _: &DispatcherMetrics) {
        unimplemented!()
    }
    async fn tx_statuses(
        &self,
        txs: &[Transaction],
    ) -> Vec<Result<TransactionStatus, LanderError>> {
        self.calls.lock().unwrap().push(
            txs.iter()
                .map(|tx| (tx.uuid.clone(), buffer_pointer(tx)))
                .collect(),
        );
        if let Some(gate) = &self.gate {
            gate.acquire().await.unwrap().forget();
        }
        if self.wrong_count {
            return vec![];
        }
        txs.iter()
            .enumerate()
            .map(|(index, _)| {
                if index == 0 {
                    Err(LanderError::NetworkError("read failed".to_owned()))
                } else {
                    Ok(TransactionStatus::Mempool)
                }
            })
            .collect()
    }
}

fn buffer_pointer(tx: &Transaction) -> usize {
    tx.payload_details[0]
        .success_criteria
        .as_ref()
        .unwrap()
        .as_ptr() as usize
}

fn fixture(status: TransactionStatus) -> Transaction {
    let mut payload = FullPayload::default();
    payload.details.success_criteria = Some(vec![7; 4096]);
    payload.details.metadata = "status allocation fixture".to_owned();
    dummy_tx(vec![payload], status)
}

fn state(adapter: Arc<BatchAdapter>) -> DispatcherState {
    let (payload_db, tx_db, _) = tmp_dbs();
    DispatcherState::new(
        payload_db,
        tx_db,
        adapter,
        DispatcherMetrics::dummy_instance(),
        "test".to_owned(),
    )
}

#[tokio::test]
async fn status_batch_preserves_selection_snapshots_errors_and_borrowing() {
    for (policy, statuses) in [
        (FinalizedStatusRead::Query, vec![]),
        (
            FinalizedStatusRead::Query,
            vec![
                TransactionStatus::PendingInclusion,
                TransactionStatus::Finalized,
                TransactionStatus::Included,
            ],
        ),
        (
            FinalizedStatusRead::TrustPersisted,
            vec![
                TransactionStatus::PendingInclusion,
                TransactionStatus::Included,
            ],
        ),
        (
            FinalizedStatusRead::TrustPersisted,
            vec![
                TransactionStatus::Finalized,
                TransactionStatus::PendingInclusion,
                TransactionStatus::Included,
                TransactionStatus::Finalized,
            ],
        ),
        (
            FinalizedStatusRead::TrustPersisted,
            vec![TransactionStatus::Finalized, TransactionStatus::Finalized],
        ),
    ] {
        let originals: Vec<_> = statuses.into_iter().map(fixture).collect();
        let input = originals.clone();
        let input_pointers: Vec<_> = input.iter().map(buffer_pointer).collect();
        let queries: Vec<_> = originals
            .iter()
            .filter(|tx| {
                !matches!(policy, FinalizedStatusRead::TrustPersisted)
                    || tx.status != TransactionStatus::Finalized
            })
            .map(|tx| tx.uuid.clone())
            .collect();
        let adapter = Arc::new(BatchAdapter::default());
        let result = read_transaction_status_batch(&state(adapter.clone()), input, policy).await;
        let calls = adapter.calls.lock().unwrap();
        assert_eq!(calls.len(), 1); // Even an empty/all-trusted batch calls the adapter.
        assert_eq!(
            calls[0]
                .iter()
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>(),
            queries
        );
        assert_eq!(result.len(), originals.len());
        for (index, (snapshot, checked, status)) in result.iter().enumerate() {
            assert_eq!(snapshot, &originals[index]);
            assert_eq!(buffer_pointer(snapshot), input_pointers[index]);
            assert_ne!(buffer_pointer(snapshot), buffer_pointer(checked));
            assert!(checked.last_status_check.is_some());
            let mut expected_checked = snapshot.clone();
            expected_checked.last_status_check = checked.last_status_check;
            assert_eq!(checked, &expected_checked);
            if let Some(query_index) = queries.iter().position(|id| id == &snapshot.uuid) {
                if queries.len() == originals.len() {
                    assert_eq!(calls[0][query_index].1, buffer_pointer(checked));
                } else {
                    assert_ne!(calls[0][query_index].1, buffer_pointer(checked));
                }
                if query_index == 0 {
                    assert!(matches!(status, Err(LanderError::NetworkError(_))));
                } else {
                    assert!(matches!(status, Ok(TransactionStatus::Mempool)));
                }
            } else {
                assert!(matches!(status, Ok(TransactionStatus::Finalized)));
            }
        }
    }
}

#[tokio::test]
#[should_panic(expected = "adapter returned a mismatched transaction status count")]
async fn status_batch_rejects_mismatched_adapter_result_count() {
    let adapter = Arc::new(BatchAdapter {
        wrong_count: true,
        ..Default::default()
    });
    read_transaction_status_batch(
        &state(adapter),
        vec![fixture(TransactionStatus::Included)],
        FinalizedStatusRead::Query,
    )
    .await;
}

#[tokio::test]
async fn cancelling_status_batch_keeps_the_original_snapshot_unchanged() {
    let adapter = Arc::new(BatchAdapter {
        gate: Some(Arc::new(Semaphore::new(0))),
        ..Default::default()
    });
    let state = state(adapter.clone());
    let original = fixture(TransactionStatus::Included);
    let snapshot = original.clone();
    let task = tokio::spawn(async move {
        read_transaction_status_batch(&state, vec![snapshot], FinalizedStatusRead::Query).await
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        while adapter.calls.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("status query should enter the adapter");
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(adapter.calls.lock().unwrap().len(), 1);
    assert_eq!(original.status, TransactionStatus::Included);
    assert!(original.last_status_check.is_none());
}
