use std::{collections::VecDeque, sync::Arc, time::Duration};

use tokio::{sync::Mutex, time::sleep};

use crate::adapter::TxBuildingResult;
use crate::dispatcher::metrics::DispatcherMetrics;
use crate::dispatcher::{BuildingStageQueue, DispatcherState};
use crate::tests::test_utils::{dummy_tx, tmp_dbs, MockAdapter};
use crate::transaction::TransactionUuid;
use crate::{
    Dispatcher, DispatcherEntrypoint, Entrypoint, FullPayload, LanderError, PayloadDropReason,
    PayloadStatus, PayloadUuid, TransactionDropReason, TransactionStatus,
};

use super::PayloadDb;

#[tokio::test]
async fn test_entrypoint_send_is_enqueued_directly() {
    let (payload_db, tx_db, _) = tmp_dbs();
    let domain = "dummy_domain".to_string();
    let metrics = DispatcherMetrics::dummy_instance();
    let adapter = Arc::new(MockAdapter::new());
    let state = DispatcherState::new(payload_db, tx_db, adapter, metrics.clone(), domain.clone());
    let building_stage_queue = state.building_stage_queue.clone();
    let dispatcher_entrypoint = DispatcherEntrypoint {
        inner: state.clone(),
    };

    let payload = FullPayload::random();
    dispatcher_entrypoint.send_payload(&payload).await.unwrap();

    assert_eq!(building_stage_queue.len().await, 1);
}

#[tokio::test]
async fn test_entrypoint_send_waits_for_recovery() {
    let (payload_db, tx_db, _) = tmp_dbs();
    let metrics = DispatcherMetrics::dummy_instance();
    let state = DispatcherState::new_recovery_pending(
        payload_db.clone(),
        tx_db,
        Arc::new(MockAdapter::new()),
        metrics,
        "dummy_domain".to_string(),
    );
    let building_stage_queue = state.building_stage_queue.clone();
    let entrypoint = DispatcherEntrypoint {
        inner: state.clone(),
    };
    let payload = FullPayload::random();
    let payload_uuid = payload.uuid().clone();

    let send_task = tokio::spawn(async move { entrypoint.send_payload(&payload).await });
    tokio::task::yield_now().await;

    assert!(payload_db
        .retrieve_payload_by_uuid(&payload_uuid)
        .await
        .unwrap()
        .is_none());
    assert_eq!(building_stage_queue.len().await, 0);

    state.mark_recovery_complete();
    send_task.await.unwrap().unwrap();

    assert!(payload_db
        .retrieve_payload_by_uuid(&payload_uuid)
        .await
        .unwrap()
        .is_some());
    assert_eq!(building_stage_queue.len().await, 1);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_entrypoint_send_is_finalized_by_dispatcher() {
    let payload = FullPayload::random();

    let adapter = MockAdapter::new();
    let adapter = mock_adapter_methods(adapter, payload.clone());
    let adapter = Arc::new(adapter);
    let (entrypoint, dispatcher) = mock_entrypoint_and_dispatcher(adapter.clone()).await;
    let metrics = dispatcher.inner.metrics.clone();

    let _payload_dispatcher = dispatcher.spawn();
    entrypoint.send_payload(&payload).await.unwrap();

    // wait until the payload status is InTransaction(Finalized)
    wait_until_payload_status(
        entrypoint.inner.payload_db.clone(),
        payload.uuid(),
        |payload_status| {
            matches!(
                payload_status,
                PayloadStatus::InTransaction(TransactionStatus::Finalized)
            )
        },
    )
    .await;
    sleep(Duration::from_millis(200)).await; // Wait for the metrics to be updated

    let metrics_assertion = MetricsAssertion {
        domain: entrypoint.inner.domain.clone(),
        finalized_txs: 1,
        building_stage_queue_length: 0,
        inclusion_stage_pool_length: 0,
        finality_stage_pool_length: 0,
        dropped_payloads: 0,
        dropped_transactions: 0,
        dropped_payload_reason: "".to_string(),
        dropped_transaction_reason: "".to_string(),
        // in `mock_adapter_methods`, the tx_status method is mocked to return `PendingInclusion` for the first 2 calls,
        // which causes the tx to be resubmitted each time
        transaction_submissions: 2,
    };
    assert_metrics(metrics, metrics_assertion);
}

/// This tests checks that we do simulation before the first submission of the payload.
/// The simulation succeeds, the transaction will be submitted and finalized.
/// The simulation fails on the second submission, but we actually won't reach that point
/// since we run simulation only for unsubmitted transactions.
#[tracing_test::traced_test]
#[tokio::test]
async fn test_entrypoint_send_fails_simulation_after_first_submission_but_finalization_succeeds() {
    let payload = FullPayload::random();

    let mut adapter = MockAdapter::new();
    adapter.expect_reprocess_txs_poll_rate().returning(|| None);
    let mut counter = 0;
    adapter.expect_simulate_tx().returning(move |_| {
        counter += 1;
        if counter == 1 {
            // estimation is successful the first time around, and the payload makes it into a tx
            Ok(vec![])
        } else {
            // the second time around, the estimation fails, say due to a network race condition
            // where the payload was delivered by someone else and now it reverts
            Err(LanderError::SimulationFailed(vec![
                "simulation failed".to_string()
            ]))
        }
    });
    let adapter = mock_adapter_methods(adapter, payload.clone());
    let adapter = Arc::new(adapter);
    let (entrypoint, dispatcher) = mock_entrypoint_and_dispatcher(adapter.clone()).await;
    let metrics = dispatcher.inner.metrics.clone();

    let _payload_dispatcher = dispatcher.spawn();
    entrypoint.send_payload(&payload).await.unwrap();

    // wait until the payload status is InTransaction(Finalized)
    wait_until_payload_status(
        entrypoint.inner.payload_db.clone(),
        payload.uuid(),
        |payload_status| {
            matches!(
                payload_status,
                PayloadStatus::InTransaction(TransactionStatus::Finalized)
            )
        },
    )
    .await;
    sleep(Duration::from_millis(200)).await; // Wait for the metrics to be updated

    let metrics_assertion = MetricsAssertion {
        domain: entrypoint.inner.domain.clone(),
        finalized_txs: 1,
        building_stage_queue_length: 0,
        inclusion_stage_pool_length: 0,
        finality_stage_pool_length: 0,
        dropped_payloads: 0,
        dropped_transactions: 0,
        dropped_payload_reason: "".to_string(),
        dropped_transaction_reason: "".to_string(),
        // in `mock_adapter_methods`, the tx_status method is mocked to return `PendingInclusion` for the first 2 calls,
        // which causes the tx to be resubmitted each time
        transaction_submissions: 2,
    };
    assert_metrics(metrics, metrics_assertion);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_entrypoint_send_fails_simulation_before_first_submission() {
    let payload = FullPayload::random();

    let mut adapter = MockAdapter::new();
    adapter.expect_reprocess_txs_poll_rate().returning(|| None);
    // the payload always fails simulation
    adapter.expect_simulate_tx().returning(move |_| {
        Err(LanderError::SimulationFailed(vec![
            "simulation failed".to_string()
        ]))
    });
    let adapter = mock_adapter_methods(adapter, payload.clone());
    let adapter = Arc::new(adapter);
    let (entrypoint, dispatcher) = mock_entrypoint_and_dispatcher(adapter.clone()).await;
    let metrics = dispatcher.inner.metrics.clone();

    let _payload_dispatcher = dispatcher.spawn();
    entrypoint.send_payload(&payload).await.unwrap();

    // wait until the payload status is InTransaction(Dropped(_))
    wait_until_payload_status(
        entrypoint.inner.payload_db.clone(),
        payload.uuid(),
        |payload_status| {
            matches!(
                payload_status,
                PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
            )
        },
    )
    .await;
    sleep(Duration::from_millis(200)).await; // Wait for the metrics to be updated

    let metrics_assertion = MetricsAssertion {
        domain: entrypoint.inner.domain.clone(),
        finalized_txs: 0,
        building_stage_queue_length: 0,
        inclusion_stage_pool_length: 0,
        finality_stage_pool_length: 0,
        dropped_payloads: 1,
        dropped_transactions: 1,
        dropped_payload_reason: "DroppedInTransaction(Other(\"Non-retryable error: Transaction simulation failed, reason: [\\\"simulation failed\\\"]\"))".to_string(),
        dropped_transaction_reason: "Other(\"Non-retryable error: Transaction simulation failed, reason: [\\\"simulation failed\\\"]\")".to_string(),
        transaction_submissions: 0,
    };
    assert_metrics(metrics, metrics_assertion);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_entrypoint_send_fails_estimation_after_first_submission() {
    let payload = FullPayload::random();

    let mut adapter = MockAdapter::new();
    adapter.expect_reprocess_txs_poll_rate().returning(|| None);
    let mut counter = 0;
    adapter.expect_estimate_tx().returning(move |_| {
        counter += 1;
        if counter == 1 {
            // estimation is successful the first time around, and the payload makes it into a tx
            Ok(())
        } else {
            // the second time around, the estimation fails, say due to a network race condition
            // where the payload was delivered by someone else and now it reverts
            Err(LanderError::EstimationFailed)
        }
    });
    let adapter = mock_adapter_methods(adapter, payload.clone());
    let adapter = Arc::new(adapter);
    let (entrypoint, dispatcher) = mock_entrypoint_and_dispatcher(adapter.clone()).await;
    let metrics = dispatcher.inner.metrics.clone();

    let _payload_dispatcher = dispatcher.spawn();
    entrypoint.send_payload(&payload).await.unwrap();

    // wait until the payload status is InTransaction(Dropped(_))
    wait_until_payload_status(
        entrypoint.inner.payload_db.clone(),
        payload.uuid(),
        |payload_status| {
            println!("Payload status: {payload_status:?}");
            matches!(
                payload_status,
                PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
            )
        },
    )
    .await;
    sleep(Duration::from_millis(200)).await; // Wait for the metrics to be updated

    let metrics_assertion = MetricsAssertion {
        domain: entrypoint.inner.domain.clone(),
        finalized_txs: 0,
        building_stage_queue_length: 0,
        inclusion_stage_pool_length: 0,
        finality_stage_pool_length: 0,
        dropped_payloads: 1,
        dropped_transactions: 1,
        dropped_payload_reason:
            "DroppedInTransaction(Other(\"Non-retryable error: Transaction estimation failed\"))"
                .to_string(),
        dropped_transaction_reason: "Other(\"Non-retryable error: Transaction estimation failed\")"
            .to_string(),
        transaction_submissions: 1,
    };
    assert_metrics(metrics, metrics_assertion);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_entrypoint_send_fails_estimation_before_first_submission() {
    let payload = FullPayload::random();

    let mut adapter = MockAdapter::new();
    adapter.expect_reprocess_txs_poll_rate().returning(|| None);
    // the payload always fails simulation
    adapter
        .expect_estimate_tx()
        .returning(move |_| Err(LanderError::EstimationFailed));
    let adapter = mock_adapter_methods(adapter, payload.clone());
    let adapter = Arc::new(adapter);
    let (entrypoint, dispatcher) = mock_entrypoint_and_dispatcher(adapter.clone()).await;
    let metrics = dispatcher.inner.metrics.clone();

    let _payload_dispatcher = dispatcher.spawn();
    entrypoint.send_payload(&payload).await.unwrap();

    // wait until the payload status is InTransaction(Dropped(_))
    wait_until_payload_status(
        entrypoint.inner.payload_db.clone(),
        payload.uuid(),
        |payload_status| {
            matches!(
                payload_status,
                PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
            )
        },
    )
    .await;
    sleep(Duration::from_millis(200)).await; // Wait for the metrics to be updated

    let metrics_assertion = MetricsAssertion {
        domain: entrypoint.inner.domain.clone(),
        finalized_txs: 0,
        building_stage_queue_length: 0,
        inclusion_stage_pool_length: 0,
        finality_stage_pool_length: 0,
        dropped_payloads: 1,
        dropped_transactions: 1,
        dropped_payload_reason:
            "DroppedInTransaction(Other(\"Non-retryable error: Transaction estimation failed\"))"
                .to_string(),
        dropped_transaction_reason: "Other(\"Non-retryable error: Transaction estimation failed\")"
            .to_string(),
        transaction_submissions: 0,
    };
    assert_metrics(metrics, metrics_assertion);
}

async fn mock_entrypoint_and_dispatcher(
    adapter: Arc<MockAdapter>,
) -> (DispatcherEntrypoint, Dispatcher) {
    let domain = "test_domain".to_string();

    let (payload_db, tx_db, _) = tmp_dbs();
    let metrics = DispatcherMetrics::dummy_instance();

    let state = DispatcherState::new(payload_db, tx_db, adapter, metrics.clone(), domain.clone());
    let dispatcher_entrypoint = DispatcherEntrypoint {
        inner: state.clone(),
    };

    let dispatcher = Dispatcher {
        inner: state.clone(),
        domain: domain.clone(),
    };
    (dispatcher_entrypoint, dispatcher)
}

async fn wait_until_payload_status<F>(
    payload_db: Arc<dyn PayloadDb>,
    payload_uuid: &PayloadUuid,
    status_check: F,
) where
    F: Fn(&PayloadStatus) -> bool,
{
    loop {
        let stored_payload = payload_db
            .retrieve_payload_by_uuid(payload_uuid)
            .await
            .unwrap()
            .unwrap();
        if status_check(&stored_payload.status) {
            break;
        }
        sleep(Duration::from_millis(100)).await;
    }
}

/// Mocks the adapter methods to return predefined values for testing purposes.
/// If a method was mocked already, it won't override it.
fn mock_adapter_methods(mut adapter: MockAdapter, payload: FullPayload) -> MockAdapter {
    adapter.expect_reprocess_txs_poll_rate().returning(|| None);
    adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(100));

    let tx = dummy_tx(vec![payload.clone()], TransactionStatus::PendingInclusion);
    let tx_building_result = TxBuildingResult::new(vec![payload.details.clone()], Some(tx));
    let txs = vec![tx_building_result];

    adapter
        .expect_build_transactions()
        .returning(move |_| txs.clone());

    let mut counter = 0;
    adapter.expect_tx_status().returning(move |_| {
        counter += 1;
        match counter {
            1 => Ok(TransactionStatus::PendingInclusion),
            2 => Ok(TransactionStatus::PendingInclusion),
            3 => Ok(TransactionStatus::Included),
            4 => Ok(TransactionStatus::Included),
            5 => Ok(TransactionStatus::Included),
            _ => Ok(TransactionStatus::Finalized),
        }
    });

    adapter.expect_simulate_tx().returning(|_| Ok(vec![]));

    adapter.expect_estimate_tx().returning(|_| Ok(()));

    adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);

    adapter.expect_submit().returning(|_| Ok(()));

    adapter
        .expect_update_vm_specific_metrics()
        .returning(|_, _| ());

    adapter.expect_reverted_payloads().returning(|_| Ok(vec![]));

    adapter.expect_post_finalized().returning(|| Ok(()));

    adapter.expect_max_batch_size().returning(|| 1);

    adapter
}

struct MetricsAssertion {
    domain: String,
    finalized_txs: u64,
    building_stage_queue_length: i64,
    inclusion_stage_pool_length: i64,
    finality_stage_pool_length: i64,
    dropped_payloads: u64,
    dropped_transactions: u64,
    dropped_payload_reason: String,
    dropped_transaction_reason: String,
    transaction_submissions: u64,
}

fn assert_metrics(metrics: DispatcherMetrics, assertion: MetricsAssertion) {
    // check metrics
    let gathered_metrics = metrics.gather().unwrap();
    let metrics_str = String::from_utf8(gathered_metrics).unwrap();
    println!("Metrics: {metrics_str}");

    let finalized_txs = metrics
        .finalized_transactions
        .with_label_values(&[&assertion.domain])
        .get();
    assert_eq!(
        finalized_txs, assertion.finalized_txs,
        "Finalized transactions metric is incorrect for domain {}",
        assertion.domain
    );
    let building_stage_queue_length = metrics
        .building_stage_queue_length
        .with_label_values(&[&assertion.domain])
        .get();
    assert_eq!(
        building_stage_queue_length, assertion.building_stage_queue_length,
        "Building stage queue length metric is incorrect"
    );
    let inclusion_stage_pool_length = metrics
        .inclusion_stage_pool_length
        .with_label_values(&[&assertion.domain])
        .get();
    assert_eq!(
        inclusion_stage_pool_length, assertion.inclusion_stage_pool_length,
        "Inclusion stage pool length metric is incorrect"
    );
    let finality_stage_pool_length = metrics
        .finality_stage_pool_length
        .with_label_values(&[&assertion.domain])
        .get();
    assert_eq!(
        finality_stage_pool_length, assertion.finality_stage_pool_length,
        "Finality stage pool length metric is incorrect"
    );
    let dropped_payloads = metrics
        .dropped_payloads
        .with_label_values(&[&assertion.domain, &assertion.dropped_payload_reason])
        .get();
    assert_eq!(
        dropped_payloads, assertion.dropped_payloads,
        "Dropped payloads metric is incorrect for domain {}",
        assertion.domain
    );
    let dropped_transactions = metrics
        .dropped_transactions
        .with_label_values(&[&assertion.domain, &assertion.dropped_transaction_reason])
        .get();
    assert_eq!(
        dropped_transactions, assertion.dropped_transactions,
        "Dropped transactions metric is incorrect for domain {}",
        assertion.domain
    );
    let transaction_submissions = metrics
        .transaction_submissions
        .with_label_values(&[&assertion.domain])
        .get();
    assert_eq!(
        transaction_submissions, assertion.transaction_submissions,
        "Transaction submissions metric is incorrect for domain {}",
        assertion.domain
    );
}
