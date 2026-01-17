use std::sync::Arc;

use hyperlane_core::ChainCommunicationError;
use hyperlane_sovereign::{SimulateResult, SimulateReverted, SimulateSkipped, SimulateSuccess};
use serde_json::json;

use crate::adapter::AdaptsChain;
use crate::LanderError;

use super::tests_common::{adapter, build_tx, MockSovereignProvider};

#[tokio::test]
async fn test_simulate_success() {
    let mut provider = MockSovereignProvider::new();
    provider.expect_simulate().returning(|_| {
        Ok(SimulateResult::Success(SimulateSuccess {
            gas_used: "1000".into(),
            priority_fee: "100".into(),
        }))
    });

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    let result = adapter.simulate_tx(&mut tx).await;

    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

#[tokio::test]
async fn test_simulate_reverted() {
    let mut provider = MockSovereignProvider::new();
    provider.expect_simulate().returning(|_| {
        Ok(SimulateResult::Reverted(SimulateReverted {
            detail: serde_json::Map::from_iter([("error".into(), json!("out of gas"))]),
        }))
    });

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    let result = adapter.simulate_tx(&mut tx).await;

    assert!(matches!(result, Err(LanderError::SimulationFailed(_))));
}

#[tokio::test]
async fn test_simulate_skipped() {
    let mut provider = MockSovereignProvider::new();
    provider.expect_simulate().returning(|_| {
        Ok(SimulateResult::Skipped(SimulateSkipped {
            reason: "nonce too low".into(),
        }))
    });

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    let result = adapter.simulate_tx(&mut tx).await;

    match result {
        Err(LanderError::SimulationFailed(reasons)) => {
            assert_eq!(reasons, vec!["nonce too low"]);
        }
        other => panic!("Expected SimulationFailed, got {:?}", other),
    }
}

#[tokio::test]
async fn test_simulate_provider_error() {
    let mut provider = MockSovereignProvider::new();
    provider
        .expect_simulate()
        .returning(|_| Err(ChainCommunicationError::CustomError("RPC error".into())));

    let adapter = adapter(Arc::new(provider));
    let mut tx = build_tx(&adapter).await;

    let result = adapter.simulate_tx(&mut tx).await;

    assert!(matches!(result, Err(LanderError::ChainCommunicationError(_))));
}
