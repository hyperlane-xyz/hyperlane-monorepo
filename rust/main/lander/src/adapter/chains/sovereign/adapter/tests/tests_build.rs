use std::sync::Arc;

use serde_json::json;

use crate::adapter::AdaptsChain;
use crate::transaction::VmSpecificTxData;

use super::tests_common::{adapter, payload, MockSovereignProvider};

#[tokio::test]
async fn test_build_transactions_success() {
    let provider = MockSovereignProvider::new();
    let provider_arc = Arc::new(provider);
    let adapter = adapter(provider_arc);

    let call_message = json!({
        "mailbox": {
            "process": {
                "metadata": [1, 2, 3, 4],
                "message": [5, 6, 7, 8],
            }
        }
    });
    let payload_data = serde_json::to_vec(&call_message).expect("Failed to serialize");
    let test_payload = payload(payload_data);

    let results = adapter.build_transactions(&[test_payload.clone()]).await;

    assert_eq!(results.len(), 1);
    let result = &results[0];
    assert!(result.maybe_tx.is_some());

    let tx = result.maybe_tx.as_ref().unwrap();
    match &tx.vm_specific_data {
        VmSpecificTxData::Sovereign(precursor) => {
            assert_eq!(precursor.call_message, call_message);
            assert!(precursor.tx_hash.is_none());
            assert!(precursor.serialized_body.is_none());
        }
        _ => panic!("Expected Sovereign transaction data"),
    }
}

#[tokio::test]
async fn test_build_transactions_invalid_json() {
    let provider = MockSovereignProvider::new();
    let provider_arc = Arc::new(provider);
    let adapter = adapter(provider_arc);

    let test_payload = payload(vec![1, 2, 3, 4]);

    let results = adapter.build_transactions(&[test_payload.clone()]).await;

    assert_eq!(results.len(), 1);
    let result = &results[0];
    assert!(result.maybe_tx.is_none());
    assert_eq!(result.payloads.len(), 1);
}

#[tokio::test]
async fn test_build_transactions_multiple_payloads() {
    let provider = MockSovereignProvider::new();
    let provider_arc = Arc::new(provider);
    let adapter = adapter(provider_arc);

    let valid_call_message = json!({"mailbox": {"process": {"metadata": [], "message": []}}});
    let valid_payload = payload(serde_json::to_vec(&valid_call_message).unwrap());
    let invalid_payload = payload(vec![0xFF, 0xFF]);

    let results = adapter.build_transactions(&[valid_payload, invalid_payload]).await;

    assert_eq!(results.len(), 2);
    assert!(results[0].maybe_tx.is_some());
    assert!(results[1].maybe_tx.is_none());
}
