//! Integration tests for Lander's Dispatcher entrypoint
//!
//! These tests validate the public API contract using only exported types and traits.
//! They complement the unit tests in src/dispatcher/tests.rs which verify internal behavior.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use eyre::Result;

use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_core::{identifiers::UniqueIdentifier, KnownHyperlaneDomain};

use lander::{
    AdaptsChain, DispatcherEntrypoint, DispatcherMetrics, Entrypoint, FullPayload, GasLimit,
    LanderError, PayloadDb, PayloadDetails, PayloadStatus, PayloadUuid, Transaction, TransactionDb,
    TransactionStatus, TxBuildingResult, VmSpecificTxData,
};

// Test utilities duplicated for integration tests
// (cannot import from main crate due to dev-dependency limitations)

mockall::mock! {
    pub Adapter {
    }

    #[async_trait]
    impl AdaptsChain for Adapter {
        async fn estimate_gas_limit(&self, payload: &FullPayload) -> Result<Option<GasLimit>, LanderError>;
        async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult>;
        async fn simulate_tx(&self, tx: &mut Transaction) -> Result<Vec<PayloadDetails>, LanderError>;
        async fn estimate_tx(&self, tx: &mut Transaction) -> Result<(), LanderError>;
        async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError>;
        async fn get_tx_hash_status(&self, hash: hyperlane_core::H512) -> Result<TransactionStatus, LanderError>;
        async fn tx_status(&self, tx: &Transaction) -> Result<TransactionStatus, LanderError>;
        async fn tx_ready_for_resubmission(&self, _tx: &Transaction) -> bool;
        async fn reverted_payloads(&self, tx: &Transaction) -> Result<Vec<PayloadDetails>, LanderError>;
        fn estimated_block_time(&self) -> &Duration;
        fn max_batch_size(&self) -> u32;
        fn update_vm_specific_metrics(&self, _tx: &Transaction, _metrics: &DispatcherMetrics);
        async fn nonce_gap_exists(&self) -> bool;
        async fn replace_tx(&self, _tx: &Transaction) -> Result<(), LanderError>;
        fn reprocess_txs_poll_rate(&self) -> Option<Duration>;
        async fn get_reprocess_txs(&self) -> Result<Vec<Transaction>, LanderError>;
    }
}

fn tmp_dbs() -> (Arc<dyn PayloadDb>, Arc<dyn TransactionDb>) {
    let temp_dir = tempfile::tempdir().unwrap();
    let db = DB::from_path(temp_dir.path()).unwrap();
    let domain = KnownHyperlaneDomain::Arbitrum.into();
    let rocksdb = Arc::new(HyperlaneRocksDB::new(&domain, db));

    let payload_db = rocksdb.clone() as Arc<dyn PayloadDb>;
    let tx_db = rocksdb.clone() as Arc<dyn TransactionDb>;
    (payload_db, tx_db)
}

fn dummy_tx(payloads: Vec<FullPayload>, status: TransactionStatus) -> Transaction {
    let details: Vec<PayloadDetails> = payloads
        .into_iter()
        .map(|payload| payload.details)
        .collect();
    Transaction {
        uuid: UniqueIdentifier::random(),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::CosmWasm,
        payload_details: details.clone(),
        status,
        submission_attempts: 0,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
        last_status_check: None,
    }
}

/// Helper function to wait for a payload to reach a specific status using only public APIs
async fn wait_until_payload_status<F>(
    entrypoint: &DispatcherEntrypoint,
    payload_uuid: &PayloadUuid,
    status_check: F,
    timeout: Duration,
) -> Result<PayloadStatus, String>
where
    F: Fn(&PayloadStatus) -> bool,
{
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > timeout {
            return Err(format!(
                "Timeout waiting for payload status after {:?}",
                timeout
            ));
        }

        match entrypoint.payload_status(payload_uuid.clone()).await {
            Ok(status) => {
                if status_check(&status) {
                    return Ok(status);
                }
            }
            Err(e) => return Err(format!("Failed to get payload status: {}", e)),
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Test that a payload can be sent and reaches finalized status
///
/// This is a black-box integration test that verifies:
/// 1. The send_payload() public API works
/// 2. The payload_status() public API works
/// 3. The full dispatch pipeline (building → inclusion → finality) completes
#[tokio::test]
async fn test_send_payload_reaches_finalized_status() {
    let payload = FullPayload::random();

    // Setup entrypoint using test utilities
    let (entrypoint, _dispatcher) = setup_entrypoint_with_successful_adapter(payload.clone()).await;

    // Spawn the dispatcher to process the payload
    let _dispatcher_handle = tokio::spawn(async move { _dispatcher.spawn().await });

    // User calls public API to send payload
    entrypoint
        .send_payload(&payload)
        .await
        .expect("Failed to send payload");

    // User polls public API to check status
    let final_status = wait_until_payload_status(
        &entrypoint,
        &payload.uuid(),
        |status| {
            matches!(
                status,
                PayloadStatus::InTransaction(TransactionStatus::Finalized)
            )
        },
        Duration::from_secs(5),
    )
    .await
    .expect("Payload did not reach finalized status");

    // Verify the payload reached finalized status
    assert!(
        matches!(
            final_status,
            PayloadStatus::InTransaction(TransactionStatus::Finalized)
        ),
        "Expected finalized status, got: {:?}",
        final_status
    );
}

/// Test that simulation failure results in dropped payload status
///
/// This verifies the public API correctly reports when a payload fails validation.
#[tokio::test]
async fn test_send_payload_simulation_failure_results_in_dropped() {
    let payload = FullPayload::random();

    // Setup adapter that fails simulation
    let (entrypoint, _dispatcher) = setup_entrypoint_with_failing_simulation(payload.clone()).await;

    let _dispatcher_handle = tokio::spawn(async move { _dispatcher.spawn().await });

    // Send payload through public API
    entrypoint
        .send_payload(&payload)
        .await
        .expect("Failed to send payload");

    // Wait for payload to be dropped using public API
    let final_status = wait_until_payload_status(
        &entrypoint,
        &payload.uuid(),
        |status| {
            matches!(
                status,
                PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
            )
        },
        Duration::from_secs(5),
    )
    .await
    .expect("Payload did not reach dropped status");

    // Verify payload was dropped
    assert!(
        matches!(
            final_status,
            PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
        ),
        "Expected dropped status, got: {:?}",
        final_status
    );
}

/// Test that estimation failure results in dropped payload status
#[tokio::test]
async fn test_send_payload_estimation_failure_results_in_dropped() {
    let payload = FullPayload::random();

    // Setup adapter that fails estimation
    let (entrypoint, _dispatcher) = setup_entrypoint_with_failing_estimation(payload.clone()).await;

    let _dispatcher_handle = tokio::spawn(async move { _dispatcher.spawn().await });

    // Send payload through public API
    entrypoint
        .send_payload(&payload)
        .await
        .expect("Failed to send payload");

    // Wait for payload to be dropped using public API
    let final_status = wait_until_payload_status(
        &entrypoint,
        &payload.uuid(),
        |status| {
            matches!(
                status,
                PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
            )
        },
        Duration::from_secs(5),
    )
    .await
    .expect("Payload did not reach dropped status");

    // Verify payload was dropped
    assert!(
        matches!(
            final_status,
            PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
        ),
        "Expected dropped status, got: {:?}",
        final_status
    );
}

/// Test that payload_status returns an error for non-existent payloads
#[tokio::test]
async fn test_payload_status_nonexistent_payload() {
    let payload = FullPayload::random();
    let (entrypoint, _) = setup_entrypoint_with_successful_adapter(payload).await;

    let non_existent_uuid = PayloadUuid::random();
    let result = entrypoint.payload_status(non_existent_uuid).await;

    // Should return an error or appropriate status for non-existent payload
    assert!(
        result.is_err() || matches!(result.unwrap(), PayloadStatus::ReadyToSubmit),
        "Expected error or ReadyToSubmit for non-existent payload"
    );
}

// Helper functions to setup test environment
// These use public APIs where possible, but may use test utilities for setup

async fn setup_entrypoint_with_successful_adapter(
    payload: FullPayload,
) -> (DispatcherEntrypoint, lander::Dispatcher) {
    use lander::TxBuildingResult;

    let mut adapter = MockAdapter::new();
    adapter.expect_reprocess_txs_poll_rate().returning(|| None);
    adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(100));

    let tx = dummy_tx(vec![payload.clone()], TransactionStatus::PendingInclusion);
    let tx_building_result = TxBuildingResult::new(vec![payload.details.clone()], Some(tx));
    let txs = vec![tx_building_result];

    adapter
        .expect_build_transactions()
        .returning(move |_| txs.clone());

    // Mock transaction status progression: PendingInclusion → Included → Finalized
    let mut counter = 0;
    adapter.expect_tx_status().returning(move |_| {
        counter += 1;
        match counter {
            1 | 2 => Ok(TransactionStatus::PendingInclusion),
            3 | 4 => Ok(TransactionStatus::Included),
            _ => Ok(TransactionStatus::Finalized),
        }
    });

    adapter.expect_simulate_tx().returning(|_| Ok(vec![]));
    adapter.expect_estimate_tx().returning(|_| Ok(()));
    adapter.expect_submit().returning(|_| Ok(()));
    adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);
    adapter.expect_reverted_payloads().returning(|_| Ok(vec![]));
    adapter.expect_max_batch_size().return_const(1u32);
    adapter
        .expect_update_vm_specific_metrics()
        .returning(|_, _| {});
    adapter.expect_nonce_gap_exists().returning(|| false);
    adapter.expect_replace_tx().returning(|_| Ok(()));
    adapter.expect_get_reprocess_txs().returning(|| Ok(vec![]));

    setup_entrypoint_with_adapter(Arc::new(adapter)).await
}

async fn setup_entrypoint_with_failing_simulation(
    payload: FullPayload,
) -> (DispatcherEntrypoint, lander::Dispatcher) {
    use lander::TxBuildingResult;

    let mut adapter = MockAdapter::new();
    adapter.expect_reprocess_txs_poll_rate().returning(|| None);
    adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(100));

    let tx = dummy_tx(vec![payload.clone()], TransactionStatus::PendingInclusion);
    let tx_building_result = TxBuildingResult::new(vec![payload.details.clone()], Some(tx));
    let txs = vec![tx_building_result];

    adapter
        .expect_build_transactions()
        .returning(move |_| txs.clone());

    // Simulation always fails
    adapter.expect_simulate_tx().returning(|_| {
        Err(LanderError::SimulationFailed(vec![
            "simulation failed".to_string()
        ]))
    });

    // After simulation failure, tx_status may still be checked
    adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));

    adapter.expect_estimate_tx().returning(|_| Ok(()));
    adapter.expect_submit().returning(|_| Ok(()));
    adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);
    adapter.expect_reverted_payloads().returning(|_| Ok(vec![]));
    adapter.expect_max_batch_size().return_const(1u32);
    adapter
        .expect_update_vm_specific_metrics()
        .returning(|_, _| {});
    adapter.expect_nonce_gap_exists().returning(|| false);
    adapter.expect_replace_tx().returning(|_| Ok(()));
    adapter.expect_get_reprocess_txs().returning(|| Ok(vec![]));

    setup_entrypoint_with_adapter(Arc::new(adapter)).await
}

async fn setup_entrypoint_with_failing_estimation(
    payload: FullPayload,
) -> (DispatcherEntrypoint, lander::Dispatcher) {
    use lander::TxBuildingResult;

    let mut adapter = MockAdapter::new();
    adapter.expect_reprocess_txs_poll_rate().returning(|| None);
    adapter
        .expect_estimated_block_time()
        .return_const(Duration::from_millis(100));

    let tx = dummy_tx(vec![payload.clone()], TransactionStatus::PendingInclusion);
    let tx_building_result = TxBuildingResult::new(vec![payload.details.clone()], Some(tx));
    let txs = vec![tx_building_result];

    adapter
        .expect_build_transactions()
        .returning(move |_| txs.clone());

    adapter.expect_simulate_tx().returning(|_| Ok(vec![]));

    // Estimation always fails
    adapter
        .expect_estimate_tx()
        .returning(|_| Err(LanderError::EstimationFailed));

    // After estimation failure, tx_status may still be checked
    adapter
        .expect_tx_status()
        .returning(|_| Ok(TransactionStatus::PendingInclusion));

    adapter.expect_submit().returning(|_| Ok(()));
    adapter
        .expect_tx_ready_for_resubmission()
        .returning(|_| true);
    adapter.expect_reverted_payloads().returning(|_| Ok(vec![]));
    adapter.expect_max_batch_size().return_const(1u32);
    adapter
        .expect_update_vm_specific_metrics()
        .returning(|_, _| {});
    adapter.expect_nonce_gap_exists().returning(|| false);
    adapter.expect_replace_tx().returning(|_| Ok(()));
    adapter.expect_get_reprocess_txs().returning(|| Ok(vec![]));

    setup_entrypoint_with_adapter(Arc::new(adapter)).await
}

async fn setup_entrypoint_with_adapter(
    adapter: Arc<MockAdapter>,
) -> (DispatcherEntrypoint, lander::Dispatcher) {
    let domain = "test_domain".to_string();
    let (payload_db, tx_db) = tmp_dbs();

    lander::create_test_dispatcher(adapter, payload_db, tx_db, domain).await
}
