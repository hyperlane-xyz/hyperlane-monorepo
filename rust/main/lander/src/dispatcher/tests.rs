use std::{collections::VecDeque, sync::Arc, time::Duration};

use tokio::{sync::Mutex, time::sleep};

use crate::adapter::TxBuildingResult;
use crate::dispatcher::metrics::DispatcherMetrics;
use crate::dispatcher::{BuildingStageQueue, DispatcherState, PayloadDbLoader};
use crate::tests::test_utils::{dummy_tx, tmp_dbs, MockAdapter};
use crate::transaction::TransactionUuid;
use crate::{
    Dispatcher, DispatcherEntrypoint, Entrypoint, FullPayload, LanderError, PayloadStatus,
    PayloadUuid, TransactionStatus,
};

use super::PayloadDb;

#[tokio::test]
async fn test_entrypoint_send_is_detected_by_loader() {
    let (payload_db, tx_db, _) = tmp_dbs();
    let building_stage_queue = BuildingStageQueue::new();
    let domain = "dummy_domain".to_string();
    let payload_db_loader = PayloadDbLoader::new(
        payload_db.clone(),
        building_stage_queue.clone(),
        domain.clone(),
    );
    let mut payload_iterator = payload_db_loader.into_iterator().await;

    let metrics = DispatcherMetrics::dummy_instance();
    let adapter = Arc::new(MockAdapter::new());
    let state = DispatcherState::new(payload_db, tx_db, adapter, metrics.clone(), domain.clone());
    let dispatcher_entrypoint = DispatcherEntrypoint {
        inner: state.clone(),
    };

    let _payload_db_loader = tokio::spawn(async move {
        payload_iterator
            .load_from_db(metrics.clone())
            .await
            .expect("Payload loader crashed");
    });

    // Simulate writing to the database
    let payload = FullPayload::random();
    dispatcher_entrypoint.send_payload(&payload).await.unwrap();

    // Check if the loader detects the new payload
    sleep(Duration::from_millis(100)).await; // Wait for the loader to process the payload
    let detected_payload_count = building_stage_queue.len().await;
    assert_eq!(
        detected_payload_count, 1,
        "Loader did not detect the new payload"
    );
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

    let _payload_dispatcher = tokio::spawn(async move { dispatcher.spawn().await });
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
async fn test_entrypoint_send_fails_simulation_after_first_submission() {
    let payload = FullPayload::random();

    let mut adapter = MockAdapter::new();
    let mut counter = 0;
    adapter.expect_estimate_tx().returning(move |_| {
        counter += 1;
        if counter == 1 {
            // simulation is successful the first time around, and the payload makes it into a tx
            Ok(())
        } else {
            // the second time around, the simulation fails, say due to a network race condition
            // where the payload was delivered by someone else and now it reverts
            Err(LanderError::SimulationFailed)
        }
    });
    let adapter = mock_adapter_methods(adapter, payload.clone());
    let adapter = Arc::new(adapter);
    let (entrypoint, dispatcher) = mock_entrypoint_and_dispatcher(adapter.clone()).await;
    let metrics = dispatcher.inner.metrics.clone();

    let _payload_dispatcher = tokio::spawn(async move { dispatcher.spawn().await });
    entrypoint.send_payload(&payload).await.unwrap();

    // wait until the payload status is InTransaction(Dropped(_))
    wait_until_payload_status(
        entrypoint.inner.payload_db.clone(),
        payload.uuid(),
        |payload_status| {
            println!("Payload status: {:?}", payload_status);
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
        dropped_payload_reason: "DroppedInTransaction(FailedSimulation)".to_string(),
        dropped_transaction_reason: "FailedSimulation".to_string(),
        transaction_submissions: 1,
    };
    assert_metrics(metrics, metrics_assertion);
}

#[tracing_test::traced_test]
#[tokio::test]
async fn test_entrypoint_send_fails_simulation_before_first_submission() {
    let payload = FullPayload::random();

    let mut adapter = MockAdapter::new();
    // the payload always fails simulation
    adapter
        .expect_estimate_tx()
        .returning(move |_| Err(LanderError::SimulationFailed));
    let adapter = mock_adapter_methods(adapter, payload.clone());
    let adapter = Arc::new(adapter);
    let (entrypoint, dispatcher) = mock_entrypoint_and_dispatcher(adapter.clone()).await;
    let metrics = dispatcher.inner.metrics.clone();

    let _payload_dispatcher = tokio::spawn(async move { dispatcher.spawn().await });
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
        dropped_payload_reason: "DroppedInTransaction(FailedSimulation)".to_string(),
        dropped_transaction_reason: "FailedSimulation".to_string(),
        transaction_submissions: 0,
    };
    assert_metrics(metrics, metrics_assertion);
}

async fn mock_entrypoint_and_dispatcher(
    adapter: Arc<MockAdapter>,
) -> (DispatcherEntrypoint, Dispatcher) {
    let domain = "test_domain".to_string();

    let (payload_db, tx_db, _) = tmp_dbs();
    let building_stage_queue = BuildingStageQueue::new();
    let payload_db_loader = PayloadDbLoader::new(
        payload_db.clone(),
        building_stage_queue.clone(),
        domain.clone(),
    );
    let mut payload_iterator = payload_db_loader.into_iterator().await;

    let metrics = DispatcherMetrics::dummy_instance();

    let state = DispatcherState::new(payload_db, tx_db, adapter, metrics.clone(), domain.clone());
    let dispatcher_entrypoint = DispatcherEntrypoint {
        inner: state.clone(),
    };

    let metrics_to_move = metrics.clone();
    let _payload_db_loader = tokio::spawn(async move {
        payload_iterator
            .load_from_db(metrics_to_move)
            .await
            .expect("Payload loader crashed");
    });

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

fn mock_adapter_methods(mut adapter: MockAdapter, payload: FullPayload) -> MockAdapter {
    adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(100));

    let tx = dummy_tx(vec![payload.clone()], TransactionStatus::PendingInclusion);
    let tx_building_result = TxBuildingResult::new(vec![payload.details.clone()], Some(tx));
    let txs = vec![tx_building_result];

    adapter
        .expect_build_transactions()
        .returning(move |_| txs.clone());

    adapter.expect_simulate_tx().returning(|_| Ok(vec![]));

    adapter.expect_estimate_tx().returning(|_| Ok(()));

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
    adapter.expect_reverted_payloads().returning(|_| Ok(vec![]));

    adapter.expect_submit().returning(|_| Ok(()));

    adapter
        .expect_update_vm_specific_metrics()
        .returning(|_, _| ());

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
    println!("Metrics: {}", metrics_str);

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
