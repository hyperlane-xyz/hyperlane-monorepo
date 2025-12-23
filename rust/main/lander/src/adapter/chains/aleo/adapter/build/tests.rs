use hyperlane_aleo::AleoTxData;
use hyperlane_core::H256;

use crate::{
    payload::{FullPayload, PayloadDetails, PayloadStatus, PayloadUuid},
    transaction::TransactionStatus,
};

use super::build_transaction_from_payload;

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
            metadata: format!("test-payload-{payload_uuid}"),
            success_criteria,
        },
        data: serde_json::to_vec(&tx_data).unwrap(),
        to: H256::zero(),
        status: PayloadStatus::ReadyToSubmit,
        value: None,
        inclusion_soft_deadline: None,
    }
}

#[test]
fn test_build_transaction_from_valid_payload() {
    let payload = create_test_payload();

    let result = build_transaction_from_payload(&payload);

    assert!(result.maybe_tx.is_some());
    assert_eq!(result.payloads.len(), 1);
    assert_eq!(result.payloads[0].uuid, payload.details.uuid);

    let tx = result.maybe_tx.as_ref().unwrap();
    assert_eq!(tx.status, TransactionStatus::PendingInclusion);
    assert_eq!(tx.tx_hashes.len(), 0);
    assert_eq!(tx.payload_details.len(), 1);
    assert_eq!(tx.payload_details[0].uuid, payload.details.uuid);

    // Verify success_criteria is preserved
    assert_eq!(
        tx.payload_details[0].success_criteria,
        payload.details.success_criteria
    );
}

#[test]
fn test_build_transaction_from_invalid_payload() {
    let mut payload = create_test_payload();
    payload.data = vec![1, 2, 3]; // Invalid JSON

    let result = build_transaction_from_payload(&payload);

    assert!(result.maybe_tx.is_none()); // Should fail to deserialize
    assert_eq!(result.payloads.len(), 1);
    assert_eq!(result.payloads[0].uuid, payload.details.uuid);
}

#[test]
fn test_build_transaction_returns_correct_payload_details() {
    let payload = create_test_payload();

    let result = build_transaction_from_payload(&payload);

    assert_eq!(result.payloads.len(), 1);
    assert_eq!(result.payloads[0].uuid, payload.details.uuid);
    assert_eq!(result.payloads[0].metadata, payload.details.metadata);
}

#[test]
fn test_build_multiple_transactions() {
    let payload1 = create_test_payload();
    let payload2 = create_test_payload();
    let payload3 = create_test_payload();

    let payloads = vec![payload1.clone(), payload2.clone(), payload3.clone()];
    let results: Vec<_> = payloads
        .iter()
        .map(build_transaction_from_payload)
        .collect();

    // Each payload gets its own transaction (no batching)
    assert_eq!(results.len(), 3);

    for (i, result) in results.iter().enumerate() {
        assert!(
            result.maybe_tx.is_some(),
            "Transaction {} should succeed",
            i
        );
        let tx = result.maybe_tx.as_ref().unwrap();
        assert_eq!(tx.payload_details.len(), 1);
        assert_eq!(tx.status, TransactionStatus::PendingInclusion);
    }
}

#[test]
fn test_build_transaction_with_empty_data() {
    let mut payload = create_test_payload();
    payload.data = vec![]; // Empty data

    let result = build_transaction_from_payload(&payload);

    // Should fail to deserialize empty data
    assert!(result.maybe_tx.is_none());
    assert_eq!(result.payloads.len(), 1);
}

#[test]
fn test_build_transaction_with_malformed_json() {
    let mut payload = create_test_payload();
    payload.data = b"{\"incomplete\": ".to_vec(); // Malformed JSON

    let result = build_transaction_from_payload(&payload);

    // Should fail to deserialize malformed JSON
    assert!(result.maybe_tx.is_none());
    assert_eq!(result.payloads.len(), 1);
}

#[test]
fn test_build_transaction_with_wrong_json_structure() {
    let mut payload = create_test_payload();
    // Valid JSON but wrong structure (missing required fields)
    payload.data = serde_json::to_vec(&serde_json::json!({
        "wrong_field": "value"
    }))
    .unwrap();

    let result = build_transaction_from_payload(&payload);

    // Should fail due to missing required fields
    assert!(result.maybe_tx.is_none());
    assert_eq!(result.payloads.len(), 1);
}

#[test]
fn test_build_transaction_with_empty_program_id() {
    let tx_data = AleoTxData {
        program_id: "".to_string(), // Empty program ID
        function_name: "test_function".to_string(),
        inputs: vec!["input1".to_string()],
    };

    let mut payload = create_test_payload();
    payload.data = serde_json::to_vec(&tx_data).unwrap();

    let result = build_transaction_from_payload(&payload);

    // Should succeed in building transaction (validation happens later)
    assert!(result.maybe_tx.is_some());
    let tx = result.maybe_tx.as_ref().unwrap();
    assert_eq!(tx.status, TransactionStatus::PendingInclusion);
}

#[test]
fn test_build_transaction_with_empty_function_name() {
    let tx_data = AleoTxData {
        program_id: "test_program.aleo".to_string(),
        function_name: "".to_string(), // Empty function name
        inputs: vec!["input1".to_string()],
    };

    let mut payload = create_test_payload();
    payload.data = serde_json::to_vec(&tx_data).unwrap();

    let result = build_transaction_from_payload(&payload);

    // Should succeed in building transaction (validation happens later)
    assert!(result.maybe_tx.is_some());
}

#[test]
fn test_build_transaction_with_no_inputs() {
    let tx_data = AleoTxData {
        program_id: "test_program.aleo".to_string(),
        function_name: "test_function".to_string(),
        inputs: vec![], // No inputs
    };

    let mut payload = create_test_payload();
    payload.data = serde_json::to_vec(&tx_data).unwrap();

    let result = build_transaction_from_payload(&payload);

    // Should succeed - some functions may not require inputs
    assert!(result.maybe_tx.is_some());
    let tx = result.maybe_tx.as_ref().unwrap();
    assert_eq!(tx.status, TransactionStatus::PendingInclusion);
}

#[test]
fn test_build_transaction_with_many_inputs() {
    let tx_data = AleoTxData {
        program_id: "test_program.aleo".to_string(),
        function_name: "test_function".to_string(),
        inputs: vec!["input".to_string(); 100], // Many inputs
    };

    let mut payload = create_test_payload();
    payload.data = serde_json::to_vec(&tx_data).unwrap();

    let result = build_transaction_from_payload(&payload);

    // Should succeed with many inputs
    assert!(result.maybe_tx.is_some());
}

#[test]
fn test_build_transaction_with_large_input_strings() {
    let large_input = "x".repeat(10000); // 10KB input string
    let tx_data = AleoTxData {
        program_id: "test_program.aleo".to_string(),
        function_name: "test_function".to_string(),
        inputs: vec![large_input.clone(), large_input],
    };

    let mut payload = create_test_payload();
    payload.data = serde_json::to_vec(&tx_data).unwrap();

    let result = build_transaction_from_payload(&payload);

    // Should succeed with large inputs
    assert!(result.maybe_tx.is_some());
}

#[test]
fn test_build_transaction_with_special_characters_in_program_id() {
    let tx_data = AleoTxData {
        program_id: "test-program_v2.aleo".to_string(), // Dashes and underscores
        function_name: "test_function".to_string(),
        inputs: vec!["input1".to_string()],
    };

    let mut payload = create_test_payload();
    payload.data = serde_json::to_vec(&tx_data).unwrap();

    let result = build_transaction_from_payload(&payload);

    assert!(result.maybe_tx.is_some());
}

#[test]
fn test_build_transaction_preserves_payload_metadata() {
    let payload = create_test_payload();
    let original_metadata = payload.details.metadata.clone();
    let original_uuid = payload.details.uuid.clone();

    let result = build_transaction_from_payload(&payload);

    // Verify metadata is preserved
    assert_eq!(result.payloads[0].metadata, original_metadata);
    assert_eq!(result.payloads[0].uuid, original_uuid);

    if let Some(tx) = result.maybe_tx {
        assert_eq!(tx.payload_details[0].metadata, original_metadata);
        assert_eq!(tx.payload_details[0].uuid, original_uuid);
    }
}

#[test]
fn test_build_transaction_creates_new_uuid_each_time() {
    let payload = create_test_payload();

    let result1 = build_transaction_from_payload(&payload);
    let result2 = build_transaction_from_payload(&payload);

    // Each transaction should have a unique UUID
    assert!(result1.maybe_tx.is_some());
    assert!(result2.maybe_tx.is_some());

    let tx1 = result1.maybe_tx.unwrap();
    let tx2 = result2.maybe_tx.unwrap();

    assert_ne!(tx1.uuid, tx2.uuid);
}

#[test]
fn test_build_transaction_initializes_fields_correctly() {
    let payload = create_test_payload();
    let result = build_transaction_from_payload(&payload);

    assert!(result.maybe_tx.is_some());
    let tx = result.maybe_tx.unwrap();

    // Verify all fields are initialized correctly
    assert_eq!(tx.tx_hashes.len(), 0);
    assert_eq!(tx.status, TransactionStatus::PendingInclusion);
    assert_eq!(tx.submission_attempts, 0);
    assert!(tx.last_submission_attempt.is_none());
    assert!(tx.last_status_check.is_none());
    assert_eq!(tx.payload_details.len(), 1);
}

#[test]
fn test_build_transaction_preserves_success_criteria_with_data() {
    let success_criteria = vec![0x12, 0x34, 0x56, 0x78, 0xAB, 0xCD, 0xEF];
    let payload = create_test_payload_with_success_criteria(Some(success_criteria.clone()));

    let result = build_transaction_from_payload(&payload);

    assert!(result.maybe_tx.is_some());
    let tx = result.maybe_tx.unwrap();

    // Verify success_criteria is preserved in transaction payload details
    assert_eq!(tx.payload_details.len(), 1);
    assert_eq!(
        tx.payload_details[0].success_criteria,
        Some(success_criteria.clone())
    );

    // Verify success_criteria is also preserved in the result payloads
    assert_eq!(result.payloads.len(), 1);
    assert_eq!(result.payloads[0].success_criteria, Some(success_criteria));
}

#[test]
fn test_build_transaction_preserves_none_success_criteria() {
    let payload = create_test_payload_with_success_criteria(None);

    let result = build_transaction_from_payload(&payload);

    assert!(result.maybe_tx.is_some());
    let tx = result.maybe_tx.unwrap();

    // Verify None success_criteria is preserved
    assert_eq!(tx.payload_details[0].success_criteria, None);
    assert_eq!(result.payloads[0].success_criteria, None);
}

#[test]
fn test_build_transaction_preserves_empty_success_criteria() {
    let payload = create_test_payload_with_success_criteria(Some(vec![]));

    let result = build_transaction_from_payload(&payload);

    assert!(result.maybe_tx.is_some());
    let tx = result.maybe_tx.unwrap();

    // Verify empty success_criteria is preserved (not converted to None)
    assert_eq!(tx.payload_details[0].success_criteria, Some(vec![]));
    assert_eq!(result.payloads[0].success_criteria, Some(vec![]));
}

#[test]
fn test_build_transaction_preserves_large_success_criteria() {
    let large_criteria = vec![0xFFu8; 1024]; // 1KB of data
    let payload = create_test_payload_with_success_criteria(Some(large_criteria.clone()));

    let result = build_transaction_from_payload(&payload);

    assert!(result.maybe_tx.is_some());
    let tx = result.maybe_tx.unwrap();

    // Verify large success_criteria is preserved
    assert_eq!(
        tx.payload_details[0].success_criteria,
        Some(large_criteria.clone())
    );
    assert_eq!(result.payloads[0].success_criteria, Some(large_criteria));
}
