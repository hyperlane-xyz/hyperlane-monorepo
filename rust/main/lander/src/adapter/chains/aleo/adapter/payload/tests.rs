use std::str::FromStr;

use hyperlane_aleo::{AleoSerialize, CurrentNetwork, DeliveryKey, Plaintext};

use crate::adapter::AdaptsChain;
use crate::TransactionStatus;

use super::super::core::tests::{create_test_adapter, create_test_transaction};

#[tokio::test]
async fn test_reverted_payloads_finalized_transaction_not_delivered() {
    use hyperlane_aleo::AleoGetMappingValue;

    let adapter = create_test_adapter();
    let mut tx = create_test_transaction();

    let delivery_key = DeliveryKey { id: [1u128, 1u128] };

    // Add success_criteria with proper AleoGetMappingValue format
    let get_mapping_value = AleoGetMappingValue {
        program_id: "mailbox.aleo".to_string(),
        mapping_name: "deliveries".to_string(),
        mapping_key: delivery_key.to_plaintext().unwrap(),
    };
    tx.payload_details[0].success_criteria = Some(serde_json::to_vec(&get_mapping_value).unwrap());

    // Set transaction status to Finalized
    tx.status = TransactionStatus::Finalized;

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // Payload is skipped because "test_key" is not a valid Plaintext format
    // When Plaintext parsing fails, we skip the payload (don't treat as reverted)
    assert_eq!(reverted.len(), 1);
}

#[tokio::test]
async fn test_reverted_payloads_finalized_transaction_without_success_criteria() {
    let adapter = create_test_adapter();
    let mut tx = create_test_transaction();

    // Ensure no success_criteria
    tx.payload_details[0].success_criteria = None;

    // Set transaction status to Finalized
    tx.status = TransactionStatus::Finalized;

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // No payloads should be reverted without success_criteria
    assert_eq!(reverted.len(), 0);
}

#[tokio::test]
async fn test_reverted_payloads_pending_transaction() {
    let adapter = create_test_adapter();
    let mut tx = create_test_transaction();

    // Add success_criteria to the payload
    tx.payload_details[0].success_criteria = Some(vec![1, 2, 3, 4]);

    // Transaction status is PendingInclusion by default
    assert_eq!(tx.status, TransactionStatus::PendingInclusion);

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // No payloads should be reverted for a pending transaction
    assert_eq!(reverted.len(), 0);
}

#[tokio::test]
async fn test_reverted_payloads_mempool_transaction() {
    let adapter = create_test_adapter();
    let mut tx = create_test_transaction();

    // Add success_criteria to the payload
    tx.payload_details[0].success_criteria = Some(vec![1, 2, 3, 4]);

    // Set transaction status to Mempool
    tx.status = TransactionStatus::Mempool;

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // No payloads should be reverted for a transaction in mempool
    assert_eq!(reverted.len(), 0);
}

#[tokio::test]
async fn test_reverted_payloads_dropped_multiple_payloads_mixed_criteria() {
    use crate::payload::PayloadDetails;
    use crate::PayloadUuid;

    let adapter = create_test_adapter();
    let mut tx = create_test_transaction();

    // Create 3 payloads: one with criteria, one without, one with criteria
    tx.payload_details = vec![
        PayloadDetails {
            uuid: PayloadUuid::random(),
            metadata: "payload-1".to_string(),
            success_criteria: Some(vec![1, 2, 3]),
        },
        PayloadDetails {
            uuid: PayloadUuid::random(),
            metadata: "payload-2".to_string(),
            success_criteria: None,
        },
        PayloadDetails {
            uuid: PayloadUuid::random(),
            metadata: "payload-3".to_string(),
            success_criteria: Some(vec![4, 5, 6]),
        },
    ];

    tx.status = TransactionStatus::Dropped(crate::TransactionDropReason::DroppedByChain);

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    // All payloads in dropped transactions are reverted, regardless of success_criteria
    assert_eq!(reverted.len(), 3);
    assert_eq!(reverted[0].metadata, "payload-1");
    assert_eq!(reverted[1].metadata, "payload-2");
    assert_eq!(reverted[2].metadata, "payload-3");
}

#[tokio::test]
async fn test_reverted_payloads_finalized_invalid_success_criteria_json() {
    let adapter = create_test_adapter();
    let mut tx = create_test_transaction();

    // Add invalid JSON as success_criteria (not a valid AleoGetMappingValue)
    tx.payload_details[0].success_criteria = Some(vec![123, 255, 0]); // Invalid JSON

    tx.status = TransactionStatus::Finalized;

    let result = adapter.reverted_payloads(&tx).await;

    // Should return error due to invalid JSON
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("Failed to parse success_criteria"));
}

#[tokio::test]
async fn test_reverted_payloads_empty_payload_details() {
    let adapter = create_test_adapter();
    let mut tx = create_test_transaction();

    // Empty payload_details
    tx.payload_details = vec![];

    // Test with different statuses
    tx.status = TransactionStatus::Finalized;
    let result = adapter.reverted_payloads(&tx).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap().len(), 0);

    tx.status = TransactionStatus::Dropped(crate::TransactionDropReason::DroppedByChain);
    let result = adapter.reverted_payloads(&tx).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap().len(), 0);
}

#[tokio::test]
async fn test_reverted_payloads_finalized_multiple_payloads_all_not_delivered() {
    use crate::payload::PayloadDetails;
    use crate::PayloadUuid;
    use hyperlane_aleo::AleoGetMappingValue;

    let adapter = create_test_adapter();
    let mut tx = create_test_transaction();

    // Create 3 payloads with proper success_criteria

    // Add success_criteria with proper AleoGetMappingValue format
    let delivery_key_1 = DeliveryKey { id: [1u128, 2u128] };
    let get_mapping_value_1 = AleoGetMappingValue {
        program_id: "mailbox.aleo".to_string(),
        mapping_name: "deliveries".to_string(),
        mapping_key: delivery_key_1.to_plaintext().unwrap(),
    };

    let delivery_key_2 = DeliveryKey { id: [1u128, 3u128] };
    let get_mapping_value_2 = AleoGetMappingValue {
        program_id: "mailbox.aleo".to_string(),
        mapping_name: "deliveries".to_string(),
        mapping_key: delivery_key_2.to_plaintext().unwrap(),
    };

    tx.payload_details = vec![
        PayloadDetails {
            uuid: PayloadUuid::random(),
            metadata: "payload-1".to_string(),
            success_criteria: Some(serde_json::to_vec(&get_mapping_value_1).unwrap()),
        },
        PayloadDetails {
            uuid: PayloadUuid::random(),
            metadata: "payload-2".to_string(),
            success_criteria: None, // No criteria
        },
        PayloadDetails {
            uuid: PayloadUuid::random(),
            metadata: "payload-3".to_string(),
            success_criteria: Some(serde_json::to_vec(&get_mapping_value_2).unwrap()),
        },
    ];

    tx.status = TransactionStatus::Finalized;

    let result = adapter.reverted_payloads(&tx).await;

    assert!(result.is_ok());
    let reverted = result.unwrap();

    assert_eq!(reverted.len(), 2);
}
