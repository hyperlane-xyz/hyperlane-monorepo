use std::sync::Arc;
use std::time::Duration;

use uuid::Uuid;

use hyperlane_aleo::{AleoSigner, AleoTxData};
use hyperlane_core::H256;

use crate::adapter::chains::{AleoAdapter, AleoTxPrecursor};
use crate::adapter::AdaptsChain;
use crate::payload::PayloadDetails;
use crate::tests::MockAleoProvider;
use crate::transaction::{Transaction, VmSpecificTxData};
use crate::{FullPayload, PayloadStatus, PayloadUuid, TransactionStatus, TransactionUuid};

use super::Precursor;

fn create_test_payload() -> FullPayload {
    create_test_payload_with_success_criteria(Some(vec![1, 2, 3, 4]))
}

fn create_test_payload_with_success_criteria(success_criteria: Option<Vec<u8>>) -> FullPayload {
    let tx_data = AleoTxData {
        program_id: "test_program.aleo".to_string(),
        function_name: "test_function".to_string(),
        inputs: vec!["input1".to_string(), "input2".to_string()],
    };

    let payload_uuid = PayloadUuid::random();

    FullPayload {
        details: PayloadDetails {
            uuid: payload_uuid.clone(),
            metadata: format!("test-payload-{}", payload_uuid),
            success_criteria,
        },
        data: serde_json::to_vec(&tx_data).unwrap(),
        to: H256::zero(),
        status: PayloadStatus::ReadyToSubmit,
        value: None,
        inclusion_soft_deadline: None,
    }
}

pub(crate) fn create_test_adapter() -> AleoAdapter<MockAleoProvider> {
    let mock_provider = MockAleoProvider;

    AleoAdapter {
        provider: Arc::new(mock_provider),
        estimated_block_time: Duration::from_secs(10),
    }
}

pub(crate) fn create_test_transaction() -> Transaction {
    let precursor = AleoTxPrecursor {
        program_id: "test_program.aleo".to_string(),
        function_name: "test_function".to_string(),
        inputs: vec!["input1".to_string(), "input2".to_string()],
    };

    let payload_uuid = PayloadUuid::random();

    Transaction {
        uuid: TransactionUuid::new(Uuid::new_v4()),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Aleo(Box::new(precursor)),
        payload_details: vec![PayloadDetails {
            uuid: payload_uuid.clone(),
            metadata: format!("test-payload-{}", payload_uuid),
            success_criteria: None,
        }],
        status: TransactionStatus::PendingInclusion,
        submission_attempts: 0,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
        last_status_check: None,
    }
}

#[tokio::test]
async fn test_simulate_tx() {
    let adapter = create_test_adapter();
    let mut tx = create_test_transaction();

    let result = adapter.simulate_tx(&mut tx).await;
    assert!(result.is_ok());

    // Aleo doesn't do payload-level simulation, so result should be empty
    assert_eq!(result.unwrap().len(), 0);
}

#[tokio::test]
async fn test_estimate_tx() {
    let adapter = create_test_adapter();
    let mut tx = create_test_transaction();

    let result = adapter.estimate_tx(&mut tx).await;
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_max_batch_size() {
    let adapter = create_test_adapter();
    assert_eq!(adapter.max_batch_size(), 1); // Aleo doesn't support batching
}

#[tokio::test]
async fn test_build_transactions_single_valid_payload() {
    let adapter = create_test_adapter();
    let payload = create_test_payload();
    let payloads = vec![payload.clone()];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 1);
    assert!(results[0].maybe_tx.is_some());
    assert_eq!(results[0].payloads.len(), 1);
    assert_eq!(results[0].payloads[0].uuid, payload.details.uuid);

    let tx = results[0].maybe_tx.as_ref().unwrap();
    assert_eq!(tx.status, TransactionStatus::PendingInclusion);
    assert_eq!(tx.tx_hashes.len(), 0);
    assert_eq!(tx.payload_details.len(), 1);

    // Verify success_criteria is preserved
    assert_eq!(
        tx.payload_details[0].success_criteria,
        payload.details.success_criteria
    );
    assert_eq!(
        results[0].payloads[0].success_criteria,
        payload.details.success_criteria
    );
}

#[tokio::test]
async fn test_build_transactions_multiple_valid_payloads() {
    let adapter = create_test_adapter();
    let payload1 = create_test_payload();
    let payload2 = create_test_payload();
    let payload3 = create_test_payload();
    let payloads = vec![payload1.clone(), payload2.clone(), payload3.clone()];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 3);

    // Each payload gets its own transaction (no batching in Aleo)
    for (i, result) in results.iter().enumerate() {
        assert!(
            result.maybe_tx.is_some(),
            "Transaction {} should succeed",
            i
        );
        let tx = result.maybe_tx.as_ref().unwrap();
        assert_eq!(tx.payload_details.len(), 1);
        assert_eq!(tx.status, TransactionStatus::PendingInclusion);
        assert_eq!(result.payloads.len(), 1);
    }

    // Verify each result corresponds to the correct payload
    assert_eq!(results[0].payloads[0].uuid, payload1.details.uuid);
    assert_eq!(results[1].payloads[0].uuid, payload2.details.uuid);
    assert_eq!(results[2].payloads[0].uuid, payload3.details.uuid);
}

#[tokio::test]
async fn test_build_transactions_with_invalid_payload() {
    let adapter = create_test_adapter();
    let mut invalid_payload = create_test_payload();
    invalid_payload.data = vec![1, 2, 3]; // Invalid JSON

    let payloads = vec![invalid_payload.clone()];
    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 1);
    assert!(results[0].maybe_tx.is_none()); // Should fail to deserialize
    assert_eq!(results[0].payloads.len(), 1);
    assert_eq!(results[0].payloads[0].uuid, invalid_payload.details.uuid);
}

#[tokio::test]
async fn test_build_transactions_mixed_valid_and_invalid() {
    let adapter = create_test_adapter();
    let valid_payload = create_test_payload();
    let mut invalid_payload = create_test_payload();
    invalid_payload.data = b"{\"incomplete\": ".to_vec(); // Malformed JSON

    let payloads = vec![valid_payload.clone(), invalid_payload.clone()];
    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 2);

    // First payload should succeed
    assert!(results[0].maybe_tx.is_some());
    assert_eq!(results[0].payloads[0].uuid, valid_payload.details.uuid);

    // Second payload should fail
    assert!(results[1].maybe_tx.is_none());
    assert_eq!(results[1].payloads[0].uuid, invalid_payload.details.uuid);
}

#[tokio::test]
async fn test_build_transactions_empty_slice() {
    let adapter = create_test_adapter();
    let payloads: Vec<FullPayload> = vec![];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 0);
}

#[tokio::test]
async fn test_build_transactions_preserves_payload_details() {
    let adapter = create_test_adapter();
    let payload = create_test_payload();
    let original_metadata = payload.details.metadata.clone();
    let original_uuid = payload.details.uuid.clone();

    let payloads = vec![payload];
    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].payloads[0].metadata, original_metadata);
    assert_eq!(results[0].payloads[0].uuid, original_uuid);

    if let Some(tx) = &results[0].maybe_tx {
        assert_eq!(tx.payload_details[0].metadata, original_metadata);
        assert_eq!(tx.payload_details[0].uuid, original_uuid);
    }
}

#[tokio::test]
async fn test_build_transactions_creates_unique_uuids() {
    let adapter = create_test_adapter();
    let payload = create_test_payload();
    let payloads = vec![payload.clone(), payload];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 2);
    assert!(results[0].maybe_tx.is_some());
    assert!(results[1].maybe_tx.is_some());

    let tx1 = results[0].maybe_tx.as_ref().unwrap();
    let tx2 = results[1].maybe_tx.as_ref().unwrap();

    // Each transaction should have a unique UUID even from the same payload
    assert_ne!(tx1.uuid, tx2.uuid);
}

#[tokio::test]
async fn test_build_transactions_initializes_fields_correctly() {
    let adapter = create_test_adapter();
    let payload = create_test_payload();
    let payloads = vec![payload];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 1);
    assert!(results[0].maybe_tx.is_some());

    let tx = results[0].maybe_tx.as_ref().unwrap();
    assert_eq!(tx.tx_hashes.len(), 0);
    assert_eq!(tx.status, TransactionStatus::PendingInclusion);
    assert_eq!(tx.submission_attempts, 0);
    assert!(tx.last_submission_attempt.is_none());
    assert!(tx.last_status_check.is_none());
    assert_eq!(tx.payload_details.len(), 1);
}

#[tokio::test]
async fn test_build_transactions_preserves_success_criteria_with_data() {
    let adapter = create_test_adapter();
    let success_criteria = vec![0x12, 0x34, 0x56, 0x78, 0xAB, 0xCD, 0xEF];
    let payload = create_test_payload_with_success_criteria(Some(success_criteria.clone()));
    let payloads = vec![payload];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 1);
    assert!(results[0].maybe_tx.is_some());

    let tx = results[0].maybe_tx.as_ref().unwrap();

    // Verify success_criteria is preserved in transaction payload details
    assert_eq!(tx.payload_details.len(), 1);
    assert_eq!(
        tx.payload_details[0].success_criteria,
        Some(success_criteria.clone())
    );

    // Verify success_criteria is also preserved in the result payloads
    assert_eq!(results[0].payloads.len(), 1);
    assert_eq!(
        results[0].payloads[0].success_criteria,
        Some(success_criteria)
    );
}

#[tokio::test]
async fn test_build_transactions_preserves_none_success_criteria() {
    let adapter = create_test_adapter();
    let payload = create_test_payload_with_success_criteria(None);
    let payloads = vec![payload];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 1);
    assert!(results[0].maybe_tx.is_some());

    let tx = results[0].maybe_tx.as_ref().unwrap();

    // Verify None success_criteria is preserved
    assert_eq!(tx.payload_details[0].success_criteria, None);
    assert_eq!(results[0].payloads[0].success_criteria, None);
}

#[tokio::test]
async fn test_build_transactions_preserves_empty_success_criteria() {
    let adapter = create_test_adapter();
    let payload = create_test_payload_with_success_criteria(Some(vec![]));
    let payloads = vec![payload];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 1);
    assert!(results[0].maybe_tx.is_some());

    let tx = results[0].maybe_tx.as_ref().unwrap();

    // Verify empty success_criteria is preserved (not converted to None)
    assert_eq!(tx.payload_details[0].success_criteria, Some(vec![]));
    assert_eq!(results[0].payloads[0].success_criteria, Some(vec![]));
}

#[tokio::test]
async fn test_build_transactions_preserves_large_success_criteria() {
    let adapter = create_test_adapter();
    let large_criteria = vec![0xFFu8; 1024]; // 1KB of data
    let payload = create_test_payload_with_success_criteria(Some(large_criteria.clone()));
    let payloads = vec![payload];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 1);
    assert!(results[0].maybe_tx.is_some());

    let tx = results[0].maybe_tx.as_ref().unwrap();

    // Verify large success_criteria is preserved
    assert_eq!(
        tx.payload_details[0].success_criteria,
        Some(large_criteria.clone())
    );
    assert_eq!(
        results[0].payloads[0].success_criteria,
        Some(large_criteria)
    );
}

#[tokio::test]
async fn test_build_transactions_preserves_success_criteria_multiple_payloads() {
    let adapter = create_test_adapter();
    let criteria1 = vec![0x01, 0x02, 0x03];
    let criteria2 = vec![0xAA, 0xBB, 0xCC];
    let payload1 = create_test_payload_with_success_criteria(Some(criteria1.clone()));
    let payload2 = create_test_payload_with_success_criteria(Some(criteria2.clone()));
    let payload3 = create_test_payload_with_success_criteria(None);
    let payloads = vec![payload1, payload2, payload3];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 3);

    // Verify first payload's success_criteria
    assert!(results[0].maybe_tx.is_some());
    let tx1 = results[0].maybe_tx.as_ref().unwrap();
    assert_eq!(
        tx1.payload_details[0].success_criteria,
        Some(criteria1.clone())
    );
    assert_eq!(results[0].payloads[0].success_criteria, Some(criteria1));

    // Verify second payload's success_criteria
    assert!(results[1].maybe_tx.is_some());
    let tx2 = results[1].maybe_tx.as_ref().unwrap();
    assert_eq!(
        tx2.payload_details[0].success_criteria,
        Some(criteria2.clone())
    );
    assert_eq!(results[1].payloads[0].success_criteria, Some(criteria2));

    // Verify third payload's None success_criteria
    assert!(results[2].maybe_tx.is_some());
    let tx3 = results[2].maybe_tx.as_ref().unwrap();
    assert_eq!(tx3.payload_details[0].success_criteria, None);
    assert_eq!(results[2].payloads[0].success_criteria, None);
}
