use std::sync::Arc;

use hyperlane_core::ChainCommunicationError;
use hyperlane_sovereign::{SimulateResult, SimulateReverted, SimulateSkipped, SimulateSuccess};
use serde_json::json;

use crate::adapter::chains::sovereign::transaction::Precursor;
use crate::adapter::AdaptsChain;
use crate::LanderError;

use super::tests_common::{adapter, build_tx, MockSovereignProvider};

#[tokio::test]
async fn test_estimate_success() {
    let mut provider = MockSovereignProvider::new();
    provider.expect_simulate().returning(|_| {
        Ok(SimulateResult::Success(SimulateSuccess {
            gas_used: "5000".into(),
            priority_fee: "200".into(),
        }))
    });

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    assert!(tx.precursor().gas_estimate.is_none());

    let result = adapter.estimate_tx(&mut tx).await;

    assert!(result.is_ok());
    let estimate = tx.precursor().gas_estimate.as_ref().unwrap();
    assert_eq!(estimate.gas_used, 5000);
    assert_eq!(estimate.priority_fee, 200);
}

#[tokio::test]
async fn test_estimate_skips_if_already_estimated() {
    let mut provider = MockSovereignProvider::new();
    // Should only be called once
    provider.expect_simulate().times(1).returning(|_| {
        Ok(SimulateResult::Success(SimulateSuccess {
            gas_used: "1000".into(),
            priority_fee: "100".into(),
        }))
    });

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    // First call should estimate
    adapter.estimate_tx(&mut tx).await.unwrap();
    assert!(tx.precursor().gas_estimate.is_some());

    // Second call should skip (mock expects only 1 call)
    adapter.estimate_tx(&mut tx).await.unwrap();
}

#[tokio::test]
async fn test_estimate_reverted() {
    let mut provider = MockSovereignProvider::new();
    provider.expect_simulate().returning(|_| {
        Ok(SimulateResult::Reverted(SimulateReverted {
            detail: serde_json::Map::from_iter([("error".into(), json!("insufficient funds"))]),
        }))
    });

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    let result = adapter.estimate_tx(&mut tx).await;

    assert!(matches!(result, Err(LanderError::SimulationFailed(_))));
    assert!(tx.precursor().gas_estimate.is_none());
}

#[tokio::test]
async fn test_estimate_skipped() {
    let mut provider = MockSovereignProvider::new();
    provider.expect_simulate().returning(|_| {
        Ok(SimulateResult::Skipped(SimulateSkipped {
            reason: "invalid nonce".into(),
        }))
    });

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    let result = adapter.estimate_tx(&mut tx).await;

    match result {
        Err(LanderError::SimulationFailed(reasons)) => {
            assert_eq!(reasons, vec!["invalid nonce"]);
        }
        other => panic!("Expected SimulationFailed, got {:?}", other),
    }
}

#[tokio::test]
async fn test_estimate_provider_error() {
    let mut provider = MockSovereignProvider::new();
    provider
        .expect_simulate()
        .returning(|_| Err(ChainCommunicationError::CustomError("connection failed".into())));

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    let result = adapter.estimate_tx(&mut tx).await;

    assert!(matches!(result, Err(LanderError::ChainCommunicationError(_))));
}
