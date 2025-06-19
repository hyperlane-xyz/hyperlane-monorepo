use std::{collections::VecDeque, sync::Arc};

use tokio::sync::Mutex;

use crate::adapter::{AdaptsChain, TxBuildingResult};
use crate::dispatcher::{metrics::DispatcherMetrics, DispatcherState, PayloadDb, TransactionDb};
use crate::payload::{DropReason, FullPayload, PayloadDetails, PayloadStatus};
use crate::tests::test_utils::{dummy_tx, initialize_payload_db, tmp_dbs, MockAdapter};
use crate::transaction::{Transaction, TransactionStatus, TransactionUuid};

use super::{BuildingStage, BuildingStageQueue};

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
async fn test_send_multiple_payloads_at_once() {
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
        .iter()
        .map(|payload| payload.details.clone())
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
    mock_adapter
        .expect_simulate_tx()
        // .times(payloads_to_send)
        .returning(move |_| Ok(vec![]));
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
