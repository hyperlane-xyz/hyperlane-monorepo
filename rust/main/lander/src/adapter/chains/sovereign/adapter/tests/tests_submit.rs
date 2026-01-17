use std::sync::Arc;

use hyperlane_core::{ChainCommunicationError, H256};
use serde_json::json;

use crate::adapter::AdaptsChain;
use crate::transaction::VmSpecificTxData;
use crate::LanderError;

use super::tests_common::{
    adapter, build_tx, h256_to_h512, payload, successful_submit_response, MockSovereignProvider,
};

#[tokio::test]
async fn test_submit_success() {
    let tx_hash = H256::random();
    let mut provider = MockSovereignProvider::new();
    provider
        .expect_build_and_submit()
        .returning(move |_| Ok((successful_submit_response(tx_hash), "body".into())));

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    adapter.submit(&mut tx).await.expect("submit failed");

    assert_eq!(tx.tx_hashes, vec![h256_to_h512(tx_hash)]);
    match &tx.vm_specific_data {
        VmSpecificTxData::Sovereign(p) => {
            assert_eq!(p.tx_hash, Some(tx_hash));
            assert_eq!(p.serialized_body, Some("body".into()));
        }
        _ => panic!("Expected Sovereign data"),
    }
}

#[tokio::test]
async fn test_submit_no_duplicate_hashes() {
    let tx_hash = H256::random();
    let mut provider = MockSovereignProvider::new();
    provider
        .expect_build_and_submit()
        .times(2)
        .returning(move |_| Ok((successful_submit_response(tx_hash), "body".into())));

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    adapter.submit(&mut tx).await.unwrap();
    adapter.submit(&mut tx).await.unwrap();

    assert_eq!(tx.tx_hashes.len(), 1);
}

#[tokio::test]
async fn test_submit_provider_error() {
    let mut provider = MockSovereignProvider::new();
    provider
        .expect_build_and_submit()
        .returning(|_| Err(ChainCommunicationError::CustomError("failed".into())));

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    let result = adapter.submit(&mut tx).await;

    assert!(matches!(result, Err(LanderError::ChainCommunicationError(_))));
    assert!(tx.tx_hashes.is_empty());
}

#[tokio::test]
async fn test_submit_hash_format() {
    let tx_hash = H256::repeat_byte(0xab);
    let mut provider = MockSovereignProvider::new();
    provider
        .expect_build_and_submit()
        .returning(move |_| Ok((successful_submit_response(tx_hash), "body".into())));

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    adapter.submit(&mut tx).await.unwrap();

    let h512 = tx.tx_hashes[0];
    assert_eq!(&h512.0[0..32], &[0u8; 32]);
    assert_eq!(&h512.0[32..64], tx_hash.as_bytes());
}

#[tokio::test]
async fn test_submit_passes_call_message() {
    let expected = json!({"mailbox": {"process": {"metadata": [1, 2], "message": [3, 4]}}});
    let expected_clone = expected.clone();

    let mut provider = MockSovereignProvider::new();
    provider
        .expect_build_and_submit()
        .withf(move |msg| *msg == expected_clone)
        .returning(|_| Ok((successful_submit_response(H256::zero()), "body".into())));

    let adapter = adapter(Arc::new(provider));
    let test_payload = payload(serde_json::to_vec(&expected).unwrap());
    let mut tx = adapter.build_transactions(&[test_payload]).await[0]
        .maybe_tx
        .clone()
        .unwrap();

    adapter.submit(&mut tx).await.expect("submit failed");
}
