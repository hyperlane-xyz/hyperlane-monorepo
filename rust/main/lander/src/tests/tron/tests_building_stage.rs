use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use ethers::abi::Function;
use ethers::types::transaction::eip2718::TypedTransaction;

use hyperlane_core::H256;

use crate::adapter::chains::tron::TronAdapter;
use crate::dispatcher::{BuildingStage, BuildingStageQueue, DispatcherState};
use crate::payload::{DropReason, PayloadDetails};
use crate::transaction::Transaction;
use crate::{DispatcherMetrics, FullPayload, PayloadStatus, PayloadUuid, TransactionStatus};

use super::super::test_utils::{initialize_payload_db, tmp_dbs};
use super::test_utils::{create_test_function, create_test_tx_request, MockTronProvider};

/// Creates a valid Tron payload with serialized (TypedTransaction, Function) data
fn create_tron_payload() -> FullPayload {
    let tx = create_test_tx_request();
    let function = create_test_function();

    let payload_uuid = PayloadUuid::random();
    let success_criteria = Some(vec![1, 2, 3, 4]);

    // Tron payload data is serialized (TypedTransaction, Function) pair
    let data = serde_json::to_vec(&(&tx, &function)).expect("Failed to serialize tx data");

    FullPayload {
        details: PayloadDetails {
            uuid: payload_uuid.clone(),
            metadata: format!("test-tron-payload-{}", payload_uuid),
            success_criteria,
        },
        data,
        to: H256::zero(),
        status: PayloadStatus::ReadyToSubmit,
        value: None,
        inclusion_soft_deadline: None,
    }
}

fn setup_building_stage() -> (
    BuildingStage,
    tokio::sync::mpsc::Receiver<Transaction>,
    BuildingStageQueue,
) {
    let (payload_db, tx_db, _) = tmp_dbs();
    let mock_provider = MockTronProvider::new();

    let adapter = TronAdapter {
        provider: Arc::new(mock_provider),
        estimated_block_time: Duration::from_millis(10),
    };

    let state = DispatcherState::new(
        payload_db,
        tx_db,
        Arc::new(adapter),
        DispatcherMetrics::dummy_instance(),
        "test-tron".to_string(),
    );

    let (sender, receiver) = tokio::sync::mpsc::channel(100);
    let queue = BuildingStageQueue::new();
    let building_stage = BuildingStage::new(queue.clone(), sender, state, "test-tron".to_string());

    (building_stage, receiver, queue)
}

async fn run_building_stage_once(
    building_stage: &BuildingStage,
    receiver: &mut tokio::sync::mpsc::Receiver<Transaction>,
    expected_tx_count: usize,
) -> Vec<Transaction> {
    // If we expect 0 transactions, just run with a timeout
    if expected_tx_count == 0 {
        tokio::select! {
            _ = building_stage.run() => vec![],
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => vec![],
        }
    } else {
        let received_txs = async {
            let mut txs = Vec::new();
            while txs.len() < expected_tx_count {
                if let Some(tx) = receiver.recv().await {
                    txs.push(tx);
                }
            }
            txs
        };

        tokio::select! {
            _ = building_stage.run() => vec![],
            txs = received_txs => txs,
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => vec![],
        }
    }
}

/// Helper function to verify transaction-level validations
fn verify_transaction_fields(tx: &Transaction) {
    // Verify transaction UUID is set
    assert!(!tx.uuid.is_nil(), "Transaction UUID should be set");

    // Verify transaction status is correct
    assert_eq!(
        tx.status,
        TransactionStatus::PendingInclusion,
        "Transaction status should be PendingInclusion"
    );

    // Verify vm_specific_data is Tron and has valid precursor
    match &tx.vm_specific_data {
        crate::transaction::VmSpecificTxData::Tron(precursor) => {
            // Verify the Tron transaction precursor has required fields
            assert!(
                !precursor.function.name.is_empty(),
                "function name should not be empty"
            );
        }
        _ => panic!("Expected Tron transaction data"),
    }

    // Verify submission attempts starts at 0
    assert_eq!(
        tx.submission_attempts, 0,
        "New transaction should have 0 submission attempts"
    );
}

/// Helper function to verify payload status transition
async fn verify_payload_status_transition(
    building_stage: &BuildingStage,
    payload_uuid: &PayloadUuid,
) {
    // Retrieve the payload from database
    let stored_payload = building_stage
        .state
        .payload_db
        .retrieve_payload_by_uuid(payload_uuid)
        .await
        .unwrap()
        .unwrap();

    // Verify payload transitioned to InTransaction status
    assert!(
        matches!(
            stored_payload.status,
            PayloadStatus::InTransaction(TransactionStatus::PendingInclusion)
        ),
        "Payload should be in InTransaction(PendingInclusion) status"
    );
}

/// Helper function to verify tx_data field validation
fn verify_tx_data_preserved(
    tx: &Transaction,
    original_tx: &TypedTransaction,
    original_function: &Function,
) {
    // Extract the Tron transaction precursor from vm_specific_data
    match &tx.vm_specific_data {
        crate::transaction::VmSpecificTxData::Tron(precursor) => {
            // Verify function name is preserved
            assert_eq!(
                precursor.function.name, original_function.name,
                "function name should be preserved"
            );

            // Verify transaction destination is preserved
            assert_eq!(
                precursor.tx.to(),
                original_tx.to(),
                "transaction 'to' address should be preserved"
            );
        }
        _ => panic!("Expected Tron transaction data"),
    }
}

#[tokio::test]
async fn test_building_stage_single_payload() {
    let (building_stage, mut receiver, queue) = setup_building_stage();

    // Create and enqueue a valid Tron payload
    let payload = create_tron_payload();
    let (original_tx, original_function): (TypedTransaction, Function) =
        serde_json::from_slice(&payload.data).unwrap();
    initialize_payload_db(&building_stage.state.payload_db, &payload).await;
    queue.push_back(payload.clone()).await;

    // Run BuildingStage and expect one transaction to be built
    let txs = run_building_stage_once(&building_stage, &mut receiver, 1).await;

    // Verify the transaction was received
    assert_eq!(txs.len(), 1);
    let tx = &txs[0];
    assert_eq!(tx.payload_details.len(), 1);
    assert_eq!(tx.payload_details[0].uuid, payload.details.uuid);
    assert_eq!(
        tx.payload_details[0].success_criteria,
        payload.details.success_criteria
    );

    // Check 1: Verify transaction-level validations
    verify_transaction_fields(tx);

    // Check 2: Verify payload status transition
    verify_payload_status_transition(&building_stage, &payload.details.uuid).await;

    // Check 3: Verify tx_data field validation
    let stored_tx = building_stage
        .state
        .tx_db
        .retrieve_transaction_by_uuid(&tx.uuid)
        .await
        .unwrap()
        .unwrap();
    verify_tx_data_preserved(&stored_tx, &original_tx, &original_function);

    // Queue should be empty after processing
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_building_stage_multiple_payloads_no_batching() {
    let (building_stage, mut receiver, queue) = setup_building_stage();

    // Create multiple Tron payloads
    let payload1 = create_tron_payload();
    let payload2 = create_tron_payload();
    let payload3 = create_tron_payload();

    // Store original tx_data for each payload
    let tx_data1: (TypedTransaction, Function) = serde_json::from_slice(&payload1.data).unwrap();
    let tx_data2: (TypedTransaction, Function) = serde_json::from_slice(&payload2.data).unwrap();
    let tx_data3: (TypedTransaction, Function) = serde_json::from_slice(&payload3.data).unwrap();

    let tx_data_map: HashMap<_, _> = [
        (payload1.details.uuid.clone(), tx_data1),
        (payload2.details.uuid.clone(), tx_data2),
        (payload3.details.uuid.clone(), tx_data3),
    ]
    .into_iter()
    .collect();

    // Initialize in DB and enqueue
    for payload in [&payload1, &payload2, &payload3] {
        initialize_payload_db(&building_stage.state.payload_db, payload).await;
        queue.push_back(payload.clone()).await;
    }

    // Run BuildingStage - since Tron doesn't batch, should get 3 transactions
    let txs = run_building_stage_once(&building_stage, &mut receiver, 3).await;

    // Verify all transactions were received
    assert_eq!(txs.len(), 3);

    // Verify each transaction
    for tx in txs.iter() {
        // Verify transaction-level validations
        verify_transaction_fields(tx);

        // Verify tx_data field validation
        let stored_tx = building_stage
            .state
            .tx_db
            .retrieve_transaction_by_uuid(&tx.uuid)
            .await
            .unwrap()
            .unwrap();
        let payload_uuid = &stored_tx.payload_details[0].uuid;
        let (expected_tx, expected_function) = tx_data_map
            .get(payload_uuid)
            .expect("UUID should exist in map");
        verify_tx_data_preserved(&stored_tx, expected_tx, expected_function);
    }

    // Verify payload status transitions for all payloads
    for payload in [&payload1, &payload2, &payload3] {
        verify_payload_status_transition(&building_stage, &payload.details.uuid).await;
    }

    // Each payload should have been processed
    let payload_details: Vec<_> = txs.iter().flat_map(|tx| &tx.payload_details).collect();
    assert_eq!(txs.len(), 3);
    let uuids: Vec<_> = payload_details.iter().map(|p| p.uuid.clone()).collect();
    assert!(uuids.contains(&payload1.details.uuid));
    assert!(uuids.contains(&payload2.details.uuid));
    assert!(uuids.contains(&payload3.details.uuid));

    // Queue should be empty
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_building_stage_invalid_payload() {
    let (building_stage, mut receiver, queue) = setup_building_stage();

    // Create a payload with invalid data that can't be deserialized as (TypedTransaction, Function)
    let mut payload = create_tron_payload();
    payload.data = vec![1, 2, 3]; // Invalid JSON

    initialize_payload_db(&building_stage.state.payload_db, &payload).await;
    queue.push_back(payload.clone()).await;

    // Run BuildingStage - should not send any transaction
    let txs = run_building_stage_once(&building_stage, &mut receiver, 0).await;

    // No transactions should be built for invalid payload
    assert_eq!(txs.len(), 0);

    // Payload should be marked as Dropped in the database
    let stored_payload = building_stage
        .state
        .payload_db
        .retrieve_payload_by_uuid(&payload.details.uuid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        stored_payload.status,
        PayloadStatus::Dropped(DropReason::FailedToBuildAsTransaction)
    );

    // Queue should be empty
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_building_stage_mixed_valid_and_invalid_payloads() {
    let (building_stage, mut receiver, queue) = setup_building_stage();

    // Create one valid and two invalid payloads
    let valid_payload = create_tron_payload();
    let (original_tx, original_function): (TypedTransaction, Function) =
        serde_json::from_slice(&valid_payload.data).unwrap();

    let mut invalid_payload1 = create_tron_payload();
    invalid_payload1.data = vec![1, 2, 3]; // Invalid JSON

    let mut invalid_payload2 = create_tron_payload();
    invalid_payload2.data = b"{\"incomplete\": ".to_vec(); // Malformed JSON

    // Initialize and enqueue all payloads
    for payload in [&valid_payload, &invalid_payload1, &invalid_payload2] {
        initialize_payload_db(&building_stage.state.payload_db, payload).await;
        queue.push_back(payload.clone()).await;
    }

    // Run BuildingStage - should only build one transaction for the valid payload
    let txs = run_building_stage_once(&building_stage, &mut receiver, 1).await;

    // Only the valid payload should be processed
    assert_eq!(txs.len(), 1);
    assert_eq!(txs[0].payload_details[0].uuid, valid_payload.details.uuid);

    // Verify transaction-level validations
    verify_transaction_fields(&txs[0]);

    // Verify payload status transition for valid payload
    verify_payload_status_transition(&building_stage, &valid_payload.details.uuid).await;

    // Verify tx_data field validation
    let stored_tx = building_stage
        .state
        .tx_db
        .retrieve_transaction_by_uuid(&txs[0].uuid)
        .await
        .unwrap()
        .unwrap();
    verify_tx_data_preserved(&stored_tx, &original_tx, &original_function);

    // Invalid payloads should be marked as Dropped
    for invalid_payload in [&invalid_payload1, &invalid_payload2] {
        let stored_payload = building_stage
            .state
            .payload_db
            .retrieve_payload_by_uuid(&invalid_payload.details.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            stored_payload.status,
            PayloadStatus::Dropped(DropReason::FailedToBuildAsTransaction)
        );
    }

    // Queue should be empty
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_building_stage_all_invalid_payloads() {
    let (building_stage, mut receiver, queue) = setup_building_stage();

    // Create 3 invalid payloads with different types of errors
    let mut payload1 = create_tron_payload();
    payload1.data = vec![]; // Empty

    let mut payload2 = create_tron_payload();
    payload2.data = vec![1, 2, 3]; // Invalid bytes

    let mut payload3 = create_tron_payload();
    payload3.data = b"not json".to_vec(); // Not JSON

    for payload in [&payload1, &payload2, &payload3] {
        initialize_payload_db(&building_stage.state.payload_db, payload).await;
        queue.push_back(payload.clone()).await;
    }

    // Run BuildingStage - should not build any transactions
    let txs = run_building_stage_once(&building_stage, &mut receiver, 0).await;

    assert_eq!(txs.len(), 0);

    // All payloads should be dropped
    for payload in [&payload1, &payload2, &payload3] {
        let stored_payload = building_stage
            .state
            .payload_db
            .retrieve_payload_by_uuid(&payload.details.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            stored_payload.status,
            PayloadStatus::Dropped(DropReason::FailedToBuildAsTransaction)
        );
    }

    // Queue should be empty
    assert_eq!(queue.len().await, 0);
}

#[tokio::test]
async fn test_building_stage_respects_max_batch_size() {
    let (building_stage, mut receiver, queue) = setup_building_stage();

    // Verify Tron adapter reports max_batch_size of 1
    assert_eq!(building_stage.state.adapter.max_batch_size(), 1);

    // Create 3 payloads to keep test fast
    let payload1 = create_tron_payload();
    let payload2 = create_tron_payload();
    let payload3 = create_tron_payload();

    for payload in [&payload1, &payload2, &payload3] {
        initialize_payload_db(&building_stage.state.payload_db, payload).await;
        queue.push_back(payload.clone()).await;
    }

    // Run BuildingStage - with max_batch_size=1, it will process payloads one at a time
    // We expect 3 transactions to be built (one for each payload)
    let txs = run_building_stage_once(&building_stage, &mut receiver, 3).await;

    // All 3 payloads should be processed, but each in its own transaction
    // (because max_batch_size=1 prevents batching)
    assert_eq!(txs.len(), 3);

    // Verify each transaction is stored in database
    for tx in &txs {
        let stored_tx = building_stage
            .state
            .tx_db
            .retrieve_transaction_by_uuid(&tx.uuid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored_tx.uuid, tx.uuid);
        assert_eq!(stored_tx.status, TransactionStatus::PendingInclusion);
        assert_eq!(stored_tx.payload_details.len(), 1);
        assert_eq!(
            stored_tx.payload_details[0].success_criteria,
            tx.payload_details[0].success_criteria
        );
    }

    // Queue should be empty after processing
    assert_eq!(queue.len().await, 0);
}
