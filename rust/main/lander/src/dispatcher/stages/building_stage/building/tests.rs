use std::{collections::VecDeque, sync::Arc};

use tokio::sync::Mutex;

use crate::adapter::{AdaptsChain, TxBuildingResult};
use crate::dispatcher::{metrics::DispatcherMetrics, DispatcherState, PayloadDb, TransactionDb};
use crate::payload::{DropReason, FullPayload, PayloadDetails, PayloadStatus};
use crate::tests::test_utils::{dummy_tx, initialize_payload_db, tmp_dbs, MockAdapter};
use crate::transaction::{Transaction, TransactionStatus, TransactionUuid};

use super::{BuildingStage, BuildingStageQueue};

#[tokio::test]
async fn test_empty_queue_no_payloads_processed() {
    let (building_stage, mut receiver, queue) = test_setup(0, true);
    // Run the building stage with an empty queue; should not send any transactions.
    let payload_details_received = run_building_stage(1, &building_stage, &mut receiver).await;
    assert!(payload_details_received.is_empty());
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_send_payloads_one_by_one() {
    const PAYLOADS_TO_SEND: usize = 3;
    let successful_build = true;
    let (building_stage, mut receiver, queue) = test_setup(PAYLOADS_TO_SEND, successful_build);

    // send a single payload to the building stage and check that it is sent to the receiver
    for _ in 0..PAYLOADS_TO_SEND {
        let payload_to_send = FullPayload::random();
        initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
        queue.push_back(payload_to_send.clone()).await;
        let payload_details_received = run_building_stage(1, &building_stage, &mut receiver).await;
        assert_eq!(
            payload_details_received,
            vec![payload_to_send.details.clone()]
        );
        assert_db_status_for_payloads(
            &building_stage.state,
            &payload_details_received,
            PayloadStatus::InTransaction(TransactionStatus::PendingInclusion),
        )
        .await;
    }
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_send_multiple_payloads_at_once_without_batching() {
    const PAYLOADS_TO_SEND: usize = 3;
    let successful_build = true;
    let (building_stage, mut receiver, queue) = test_setup(PAYLOADS_TO_SEND, successful_build);

    let mut sent_payloads = Vec::new();
    for _ in 0..PAYLOADS_TO_SEND {
        let payload_to_send = FullPayload::random();
        initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
        queue.push_back(payload_to_send.clone()).await;
        sent_payloads.push(payload_to_send);
    }

    // send multiple payloads to the building stage and check that they are sent to the receiver in the same order
    let payload_details_received =
        run_building_stage(PAYLOADS_TO_SEND, &building_stage, &mut receiver).await;
    let expected_payload_details = sent_payloads
        .into_iter()
        .map(|payload| payload.details)
        .collect::<Vec<_>>();
    assert_eq!(payload_details_received, expected_payload_details);
    assert_db_status_for_payloads(
        &building_stage.state,
        &payload_details_received,
        PayloadStatus::InTransaction(TransactionStatus::PendingInclusion),
    )
    .await;
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_txs_failed_to_build() {
    const PAYLOADS_TO_SEND: usize = 3;
    let successful_build = false;
    let (building_stage, mut receiver, queue) = test_setup(PAYLOADS_TO_SEND, successful_build);

    for _ in 0..PAYLOADS_TO_SEND {
        let payload_to_send = FullPayload::random();
        initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
        queue.push_back(payload_to_send.clone()).await;
        let payload_details_received = run_building_stage(1, &building_stage, &mut receiver).await;
        assert_eq!(payload_details_received, vec![]);
        assert_db_status_for_payloads(
            &building_stage.state,
            &payload_details_received,
            PayloadStatus::Dropped(DropReason::FailedToBuildAsTransaction),
        )
        .await;
    }
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_batch_larger_than_queue() {
    // Adapter will allow a batch of 5, but only 2 payloads are queued.
    let payloads_to_send = 2;
    let batch_size = 5;
    let (payload_db, tx_db, _) = tmp_dbs();
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_build_transactions()
        .times(1)
        .returning(move |payloads| dummy_built_tx(payloads.to_vec(), true));
    mock_adapter
        .expect_max_batch_size()
        .returning(move || batch_size);
    let (building_stage, mut receiver, queue) =
        dummy_stage_receiver_queue(mock_adapter, payload_db, tx_db);

    let mut sent_payloads = Vec::new();
    for _ in 0..payloads_to_send {
        let payload_to_send = FullPayload::random();
        initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
        queue.push_back(payload_to_send.clone()).await;
        sent_payloads.push(payload_to_send);
    }

    let payload_details_received =
        run_building_stage(payloads_to_send, &building_stage, &mut receiver).await;
    let expected_payload_details = sent_payloads
        .into_iter()
        .map(|payload| payload.details)
        .collect::<Vec<_>>();
    assert_eq!(payload_details_received, expected_payload_details);
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_send_multiple_payloads_at_once_with_batching() {
    const PAYLOADS_TO_SEND: usize = 6;
    let batch_size = 3;
    let successful_build = true;
    let (payload_db, tx_db, _) = tmp_dbs();
    let mut mock_adapter = MockAdapter::new();
    // Should be called twice: 6 payloads, batch size 3
    mock_adapter
        .expect_build_transactions()
        .times(2)
        .returning(move |payloads| dummy_built_tx(payloads.to_vec(), successful_build));
    mock_adapter
        .expect_max_batch_size()
        .returning(move || batch_size);
    let (building_stage, mut receiver, queue) =
        dummy_stage_receiver_queue(mock_adapter, payload_db, tx_db);

    let mut sent_payloads = Vec::new();
    for _ in 0..PAYLOADS_TO_SEND {
        let payload_to_send = FullPayload::random();
        initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
        queue.push_back(payload_to_send.clone()).await;
        sent_payloads.push(payload_to_send);
    }

    // Should receive all payloads in two batches
    let payload_details_received =
        run_building_stage(PAYLOADS_TO_SEND, &building_stage, &mut receiver).await;
    let expected_payload_details = sent_payloads
        .into_iter()
        .map(|payload| payload.details)
        .collect::<Vec<_>>();
    assert_eq!(payload_details_received, expected_payload_details);
    assert_db_status_for_payloads(
        &building_stage.state,
        &payload_details_received,
        PayloadStatus::InTransaction(TransactionStatus::PendingInclusion),
    )
    .await;
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_adapter_returns_empty_result() {
    let (payload_db, tx_db, _) = tmp_dbs();
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_build_transactions()
        .times(1)
        .returning(|_| vec![]); // Adapter returns empty result
    mock_adapter.expect_max_batch_size().returning(|| 1);
    let (building_stage, mut receiver, queue) =
        dummy_stage_receiver_queue(mock_adapter, payload_db, tx_db);

    let payload_to_send = FullPayload::random();
    initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
    queue.push_back(payload_to_send.clone()).await;

    // Should not receive any payloads, but also not panic
    let payload_details_received = run_building_stage(1, &building_stage, &mut receiver).await;
    assert!(payload_details_received.is_empty());
    // The queue should still be empty, as the payload was "processed"
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_adapter_returns_result_with_empty_payloads() {
    let (payload_db, tx_db, _) = tmp_dbs();
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_build_transactions()
        .times(1)
        .returning(|_| vec![TxBuildingResult::new(vec![], None)]);
    mock_adapter.expect_max_batch_size().returning(|| 1);
    let (building_stage, mut receiver, queue) =
        dummy_stage_receiver_queue(mock_adapter, payload_db, tx_db);

    let payload_to_send = FullPayload::random();
    initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
    queue.push_back(payload_to_send.clone()).await;

    // Should not receive any payloads, but also not panic
    let payload_details_received = run_building_stage(1, &building_stage, &mut receiver).await;
    assert!(payload_details_received.is_empty());
    // The queue should still be empty, as the payload was "processed"
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_queue_filled_and_cleared() {
    // Fill the queue, process, then ensure it's empty and can be refilled
    let (building_stage, mut receiver, queue) = test_setup(3, true);

    let payload1 = FullPayload::random();
    let payload2 = FullPayload::random();
    initialize_payload_db(&building_stage.state.payload_db, &payload1).await;
    initialize_payload_db(&building_stage.state.payload_db, &payload2).await;
    queue.push_back(payload1.clone()).await;
    queue.push_back(payload2.clone()).await;

    let payload_details_received = run_building_stage(2, &building_stage, &mut receiver).await;
    assert_eq!(
        payload_details_received,
        vec![payload1.details.clone(), payload2.details.clone()]
    );
    assert_eq!(queue.len().await, 0);

    // Refill and process again
    let payload3 = FullPayload::random();
    initialize_payload_db(&building_stage.state.payload_db, &payload3).await;
    queue.push_back(payload3.clone()).await;
    let payload_details_received = run_building_stage(1, &building_stage, &mut receiver).await;
    assert_eq!(payload_details_received, vec![payload3.details.clone()]);
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_channel_send_failure() {
    // Simulate channel send failure by closing the receiver before running
    let (payload_db, tx_db, _) = tmp_dbs();
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_build_transactions()
        .returning(|payloads| dummy_built_tx(payloads.to_vec(), true));
    mock_adapter.expect_max_batch_size().returning(|| 1);
    let adapter = Arc::new(mock_adapter) as Arc<dyn AdaptsChain>;
    let state = DispatcherState::new(
        payload_db,
        tx_db,
        adapter,
        DispatcherMetrics::dummy_instance(),
        "dummy_domain".to_string(),
    );
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    let queue = BuildingStageQueue::new();
    let building_stage =
        BuildingStage::new(queue.clone(), sender, state, "test_domain".to_string());

    let payload_to_send = FullPayload::random();
    initialize_payload_db(&building_stage.state.payload_db, &payload_to_send).await;
    queue.push_back(payload_to_send.clone()).await;

    // Drop the receiver to simulate channel send failure
    drop(receiver);

    // Should not panic, but an error will be logged
    // (We can't assert log output here, but we can ensure no panic and the queue is empty)
    let _ = tokio::time::timeout(
        tokio::time::Duration::from_millis(100),
        building_stage.run(),
    )
    .await;
    assert_eq!(queue.len().await, 0);
}

async fn run_building_stage(
    sent_payload_count: usize,
    building_stage: &BuildingStage,
    receiver: &mut tokio::sync::mpsc::Receiver<Transaction>,
) -> Vec<PayloadDetails> {
    // future that receives `sent_payload_count` payloads from the building stage
    let received_payloads = async {
        let mut received_payloads = Vec::new();
        while received_payloads.len() < sent_payload_count {
            let tx_received = receiver.recv().await.unwrap();
            let payload_details_received = tx_received.payload_details;
            received_payloads.extend_from_slice(&payload_details_received);
        }
        received_payloads
    };

    // give the building stage 100ms to send the transaction(s) to the receiver
    tokio::select! {
        res = building_stage.run() => res,
        // this arm runs until all sent payloads are sent as txs
        payloads = received_payloads => {
            return payloads;
        },
        // this arm is the timeout
        _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {},
    };
    vec![]
}

fn test_setup(
    payloads_to_send: usize,
    successful_build: bool,
) -> (
    BuildingStage,
    tokio::sync::mpsc::Receiver<Transaction>,
    BuildingStageQueue,
) {
    let (payload_db, tx_db, _) = tmp_dbs();
    let mut mock_adapter = MockAdapter::new();
    mock_adapter
        .expect_build_transactions()
        .times(payloads_to_send)
        .returning(move |payloads| dummy_built_tx(payloads.to_vec(), successful_build.clone()));
    mock_adapter.expect_max_batch_size().returning(|| 1);
    dummy_stage_receiver_queue(mock_adapter, payload_db, tx_db)
}

fn dummy_stage_receiver_queue(
    mock_adapter: MockAdapter,
    payload_db: Arc<dyn PayloadDb>,
    tx_db: Arc<dyn TransactionDb>,
) -> (
    BuildingStage,
    tokio::sync::mpsc::Receiver<Transaction>,
    BuildingStageQueue,
) {
    let adapter = Arc::new(mock_adapter) as Arc<dyn AdaptsChain>;
    let state = DispatcherState::new(
        payload_db,
        tx_db,
        adapter,
        DispatcherMetrics::dummy_instance(),
        "dummy_domain".to_string(),
    );
    let (sender, receiver) = tokio::sync::mpsc::channel(100);
    let queue = BuildingStageQueue::new();
    let building_stage =
        BuildingStage::new(queue.clone(), sender, state, "test_domain".to_string());
    (building_stage, receiver, queue)
}

fn dummy_built_tx(payloads: Vec<FullPayload>, success: bool) -> Vec<TxBuildingResult> {
    let details: Vec<PayloadDetails> = payloads
        .clone()
        .into_iter()
        .map(|payload| payload.details)
        .collect();
    let maybe_transaction = if success {
        Some(dummy_tx(payloads, TransactionStatus::PendingInclusion))
    } else {
        None
    };
    let tx_building_result = TxBuildingResult::new(details, maybe_transaction);
    vec![tx_building_result]
}

async fn assert_db_status_for_payloads(
    state: &DispatcherState,
    payloads: &[PayloadDetails],
    expected_status: PayloadStatus,
) {
    for payload in payloads {
        let payload_from_db = state
            .payload_db
            .retrieve_payload_by_uuid(&payload.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(payload_from_db.status, expected_status);
    }
}
