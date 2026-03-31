use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::abi::Function;
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::U256;
use tokio::sync::mpsc;
use tracing_test::traced_test;

use hyperlane_core::{ChainCommunicationError, ChainResult, KnownHyperlaneDomain, H256, H512};
use hyperlane_tron::TronProviderForLander;

use crate::adapter::chains::tron::{TronAdapter, TronTxPrecursor};
use crate::dispatcher::{DispatcherState, InclusionStage, PayloadDb, TransactionDb};
use crate::payload::PayloadDetails;
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{Transaction, VmSpecificTxData};
use crate::{
    DispatcherMetrics, FullPayload, PayloadStatus, PayloadUuid, TransactionStatus, TransactionUuid,
};

use super::test_utils::{
    create_receipt_with_block, create_test_function, create_test_tx_request, MockTronProvider,
};

const TEST_BLOCK_TIME: Duration = Duration::from_millis(10);
const TEST_DOMAIN: KnownHyperlaneDomain = KnownHyperlaneDomain::Arbitrum;

/// Expected transaction state at each step of the inclusion process
#[derive(Clone, Debug)]
struct ExpectedTronTxState {
    pub status: TransactionStatus,
    pub retries: u32,
}

/// Mock provider that can be configured for different test scenarios
struct ConfigurableMockProvider {
    /// Counter for transaction submissions
    submit_counter: std::sync::Mutex<u32>,
    /// Should submit fail?
    should_submit_fail: bool,
    /// How many times to fail before succeeding
    fail_count: std::sync::Mutex<u32>,
    max_failures: u32,
    /// Finalized block number
    finalized_block: u32,
    /// Transaction receipt to return (None = not found, Some(None) = mempool, Some(Some(n)) = included at block n)
    receipt_block: Option<u64>,
}

impl ConfigurableMockProvider {
    fn new() -> Self {
        Self {
            submit_counter: std::sync::Mutex::new(0),
            should_submit_fail: false,
            fail_count: std::sync::Mutex::new(0),
            max_failures: 0,
            finalized_block: 100,
            receipt_block: None,
        }
    }

    fn with_submit_failure() -> Self {
        Self {
            should_submit_fail: true,
            ..Self::new()
        }
    }

    fn with_finalized_transaction() -> Self {
        Self {
            receipt_block: Some(50), // Block 50, finalized block is 100
            finalized_block: 100,
            ..Self::new()
        }
    }

    fn with_retryable_error(max_failures: u32) -> Self {
        Self {
            max_failures,
            ..Self::new()
        }
    }
}

#[async_trait]
impl TronProviderForLander for ConfigurableMockProvider {
    async fn get_transaction_receipt(
        &self,
        _transaction_hash: H512,
    ) -> ChainResult<Option<ethers::types::TransactionReceipt>> {
        match self.receipt_block {
            None => Ok(None), // Transaction not found
            Some(block) => Ok(Some(create_receipt_with_block(Some(block)))),
        }
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(self.finalized_block)
    }

    async fn submit_tx(&self, _tx: &TypedTransaction) -> ChainResult<H256> {
        let mut counter = self.submit_counter.lock().unwrap();
        *counter += 1;

        if self.should_submit_fail {
            return Err(ChainCommunicationError::from_other_str(
                "Mock: Transaction submission failed",
            ));
        }

        // Check for temporary failures - use SERVER_BUSY which is recognized as retryable by Tron
        let mut fail_count = self.fail_count.lock().unwrap();
        if *fail_count < self.max_failures {
            *fail_count += 1;
            return Err(ChainCommunicationError::from_other_str(
                "SERVER_BUSY: node is busy, please retry",
            ));
        }

        Ok(H256::random())
    }

    async fn estimate_gas(&self, _tx: &TypedTransaction) -> ChainResult<U256> {
        Ok(U256::from(21_000))
    }

    async fn call<T: ethers::abi::Detokenize>(
        &self,
        _tx: &TypedTransaction,
        _function: &Function,
    ) -> ChainResult<T> {
        Err(ChainCommunicationError::from_other_str(
            "Mock provider: call not implemented",
        ))
    }
}

fn mock_dispatcher_state_with_provider<P>(provider: P, block_time: Duration) -> DispatcherState
where
    P: TronProviderForLander + 'static,
{
    let (payload_db, tx_db, _) = tmp_dbs();
    let adapter = TronAdapter {
        provider: Arc::new(provider),
        estimated_block_time: block_time,
    };
    DispatcherState::new(
        payload_db,
        tx_db,
        Arc::new(adapter),
        DispatcherMetrics::dummy_instance(),
        "test".to_string(),
    )
}

/// Helper function to create a test Tron precursor
fn create_test_precursor() -> TronTxPrecursor {
    TronTxPrecursor::new(create_test_tx_request(), create_test_function())
}

/// Helper function to create a test Tron transaction and store it in the DB
async fn mock_tron_tx(
    payload_db: &Arc<dyn PayloadDb>,
    tx_db: &Arc<dyn TransactionDb>,
    status: TransactionStatus,
) -> Transaction {
    let precursor = create_test_precursor();
    let data =
        serde_json::to_vec(&(&precursor.tx, &precursor.function)).expect("Failed to serialize");

    let payload_uuid = PayloadUuid::random();
    let payload = FullPayload {
        details: PayloadDetails {
            uuid: payload_uuid.clone(),
            metadata: format!("test-payload-{}", payload_uuid),
            success_criteria: None, // Set by tests as needed
        },
        data,
        to: H256::zero(),
        status: PayloadStatus::InTransaction(status.clone()),
        value: None,
        inclusion_soft_deadline: None,
    };

    payload_db.store_payload_by_uuid(&payload).await.unwrap();

    let tx = Transaction {
        uuid: TransactionUuid::new(uuid::Uuid::new_v4()),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Tron(Box::new(precursor)),
        payload_details: vec![payload.details.clone()],
        status,
        submission_attempts: 0,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
        last_status_check: None,
    };

    tx_db.store_transaction_by_uuid(&tx).await.unwrap();
    tx
}

async fn run_and_expect_successful_inclusion(
    expected_states: Vec<ExpectedTronTxState>,
    provider: ConfigurableMockProvider,
    block_time: Duration,
) {
    let dispatcher_state = mock_dispatcher_state_with_provider(provider, block_time);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_tron_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::PendingInclusion,
    )
    .await;

    let mock_domain = TEST_DOMAIN.into();
    inclusion_stage_pool
        .lock()
        .await
        .insert(created_tx.uuid.clone(), created_tx.clone());

    // Run inclusion stage steps and verify state transitions
    for (step, expected_state) in expected_states.iter().enumerate() {
        // Retrieve current tx state
        let current_tx = dispatcher_state
            .tx_db
            .retrieve_transaction_by_uuid(&created_tx.uuid)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            current_tx.status, expected_state.status,
            "Step {}: Expected status {:?}, got {:?}",
            step, expected_state.status, current_tx.status
        );
        assert_eq!(
            current_tx.submission_attempts, expected_state.retries,
            "Step {}: Expected {} retries, got {}",
            step, expected_state.retries, current_tx.submission_attempts
        );

        // Process one step
        let result = InclusionStage::process_txs_step(
            &inclusion_stage_pool,
            &finality_stage_sender,
            &dispatcher_state,
            mock_domain,
        )
        .await;
        assert!(result.is_ok(), "Step {} should succeed", step);
    }

    // Check if transaction was sent to finality stage
    let maybe_tx = tokio::time::timeout(Duration::from_millis(100), finality_stage_receiver.recv())
        .await
        .ok()
        .flatten();

    // The last expected state should be Finalized if we expect the tx to reach finality
    let final_state = expected_states.last().unwrap();
    if final_state.status == TransactionStatus::Finalized {
        assert!(
            maybe_tx.is_some(),
            "Transaction should be sent to finality stage"
        );
    }
}

#[tokio::test]
#[traced_test]
async fn test_tron_inclusion_happy_path() {
    let block_time = Duration::from_millis(0); // Immediate resubmission for testing
    let mock_provider = ConfigurableMockProvider::with_finalized_transaction();

    let expected_tx_states = vec![
        ExpectedTronTxState {
            status: TransactionStatus::PendingInclusion,
            retries: 0,
        },
        ExpectedTronTxState {
            status: TransactionStatus::Mempool,
            retries: 1,
        },
        ExpectedTronTxState {
            status: TransactionStatus::Finalized,
            retries: 1,
        },
    ];

    run_and_expect_successful_inclusion(expected_tx_states, mock_provider, block_time).await;
}

#[tokio::test]
#[traced_test]
async fn test_tron_inclusion_submission_failure_drops_tx() {
    let block_time = Duration::from_millis(0);
    let mock_provider = ConfigurableMockProvider::with_submit_failure();

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_tron_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::PendingInclusion,
    )
    .await;

    let mock_domain = TEST_DOMAIN.into();
    inclusion_stage_pool
        .lock()
        .await
        .insert(created_tx.uuid.clone(), created_tx.clone());

    // Run the inclusion stage step, which should drop the tx due to submission failure
    let result = InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await;

    // The result should be Ok (error is handled internally)
    assert!(result.is_ok());

    // The pool should be empty (tx was dropped)
    assert!(inclusion_stage_pool.lock().await.is_empty());

    // The transaction should be marked as Dropped in the DB
    let retrieved_tx = dispatcher_state
        .tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(retrieved_tx.status, TransactionStatus::Dropped(_)),
        "Transaction should be dropped"
    );

    // The payload should be marked as Dropped in the DB
    for detail in &created_tx.payload_details {
        let payload = dispatcher_state
            .payload_db
            .retrieve_payload_by_uuid(&detail.uuid)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(
                payload.status,
                PayloadStatus::InTransaction(TransactionStatus::Dropped(_))
            ),
            "Payload should be dropped"
        );
    }

    // No transaction should be sent to the finality stage
    let maybe_tx = tokio::time::timeout(Duration::from_millis(100), finality_stage_receiver.recv())
        .await
        .ok()
        .flatten();
    assert!(
        maybe_tx.is_none(),
        "No transaction should be sent to finality stage"
    );
}

#[tokio::test]
#[traced_test]
async fn test_tron_tx_ready_for_resubmission_block_time() {
    // Use 1 second block time so that as_secs() returns 1, not 0
    // Tron's resubmission check uses: elapsed >= estimated_block_time.as_secs() * 18
    let block_time = Duration::from_secs(1);
    let mock_provider = MockTronProvider::new();

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);

    let mut tx = mock_tron_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::PendingInclusion,
    )
    .await;

    // Set last submission attempt to now - transaction should NOT be ready for resubmission
    tx.last_submission_attempt = Some(chrono::Utc::now());

    // Ensure the transaction is not ready for resubmission immediately
    // Tron uses 18 * block_time as the resubmission threshold (18 seconds with 1s block time)
    assert!(
        !dispatcher_state
            .adapter
            .tx_ready_for_resubmission(&tx)
            .await,
        "Transaction should NOT be ready for resubmission immediately after submission"
    );

    // Set last submission attempt to 20 seconds ago - should now be ready
    tx.last_submission_attempt = Some(chrono::Utc::now() - chrono::Duration::seconds(20));

    // Ensure the transaction is now ready for resubmission
    assert!(
        dispatcher_state
            .adapter
            .tx_ready_for_resubmission(&tx)
            .await,
        "Transaction should be ready for resubmission after 18+ seconds"
    );
}

#[tokio::test]
#[traced_test]
async fn test_tron_inclusion_retryable_error() {
    // Test that retryable errors are handled and eventually succeed
    let block_time = Duration::from_millis(0);
    let mock_provider = ConfigurableMockProvider::with_retryable_error(2); // Fail twice, then succeed

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);
    let (finality_stage_sender, _finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_tron_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::PendingInclusion,
    )
    .await;

    let mock_domain = TEST_DOMAIN.into();
    inclusion_stage_pool
        .lock()
        .await
        .insert(created_tx.uuid.clone(), created_tx.clone());

    // First attempt should fail with retryable error
    let result = InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await;

    assert!(result.is_ok(), "First attempt should not drop transaction");

    // Transaction should still be in pool (not dropped)
    assert!(
        inclusion_stage_pool
            .lock()
            .await
            .contains_key(&created_tx.uuid),
        "Transaction should remain in pool after retryable error"
    );

    // Second attempt should also fail
    let result = InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await;

    assert!(result.is_ok(), "Second attempt should not drop transaction");

    // Third attempt should succeed
    let result = InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await;

    assert!(result.is_ok(), "Third attempt should succeed");

    // Transaction should be in Mempool status after successful submission
    let retrieved_tx = dispatcher_state
        .tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(retrieved_tx.status, TransactionStatus::Mempool),
        "Transaction status should be Mempool after successful submission, got: {:?}",
        retrieved_tx.status
    );

    // Transaction should remain in pool for status checking (not removed yet)
    assert!(
        inclusion_stage_pool
            .lock()
            .await
            .contains_key(&created_tx.uuid),
        "Transaction should remain in pool for status checking after submission"
    );
}

#[tokio::test]
#[traced_test]
async fn test_tron_inclusion_gas_estimation() {
    // Test that gas estimation is performed before submission
    let block_time = Duration::from_millis(0);
    let mock_provider = MockTronProvider::new().with_gas_estimate(U256::from(150_000));

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);
    let (finality_stage_sender, _finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_tron_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::PendingInclusion,
    )
    .await;

    let mock_domain = TEST_DOMAIN.into();
    inclusion_stage_pool
        .lock()
        .await
        .insert(created_tx.uuid.clone(), created_tx.clone());

    // Process one step
    let result = InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await;
    assert!(result.is_ok());

    // Retrieve the tx and check gas was set
    let retrieved_tx = dispatcher_state
        .tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();

    // Check that gas was estimated and set on the precursor
    match &retrieved_tx.vm_specific_data {
        VmSpecificTxData::Tron(precursor) => {
            assert!(
                precursor.tx.gas().is_some(),
                "Gas should be set after estimation"
            );
            assert_eq!(
                precursor.tx.gas(),
                Some(&U256::from(150_000)),
                "Gas should match estimated value"
            );
        }
        _ => panic!("Expected Tron VmSpecificTxData"),
    }
}
