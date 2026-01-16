use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use tokio::{select, sync::mpsc};
use tracing_test::traced_test;

use hyperlane_aleo::{
    AleoConfirmedTransaction, AleoProviderForLander, AleoUnconfirmedTransaction, CurrentNetwork,
};
use hyperlane_core::{ChainCommunicationError, ChainResult, KnownHyperlaneDomain, H512};

use crate::adapter::chains::AleoAdapter;
use crate::dispatcher::{DispatcherState, InclusionStage, PayloadDb, TransactionDb};
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::Transaction;
use crate::{DispatcherMetrics, FullPayload, PayloadStatus, TransactionStatus};

use super::test_utils::MockAleoProvider;

const TEST_BLOCK_TIME: Duration = Duration::from_millis(10);
const TEST_DOMAIN: KnownHyperlaneDomain = KnownHyperlaneDomain::Arbitrum;

/// Expected transaction state at each step of the inclusion process
#[derive(Clone, Debug)]
struct ExpectedAleoTxState {
    pub status: TransactionStatus,
    pub retries: u32,
}

/// Mock provider that can be configured for different test scenarios
struct ConfigurableMockProvider {
    /// Counter for transaction submissions
    submit_counter: std::sync::Mutex<u32>,
    /// Counter for confirmed transaction checks
    confirmed_counter: std::sync::Mutex<u32>,
    /// Counter for unconfirmed transaction checks
    unconfirmed_counter: std::sync::Mutex<u32>,
    /// Should submit fail?
    should_submit_fail: bool,
    /// Transaction hash to return
    tx_hash: H512,
    /// JSON fixture data for confirmed transaction
    confirmed_fixture: Option<String>,
    /// JSON fixture data for unconfirmed transaction
    unconfirmed_fixture: Option<String>,
}

impl ConfigurableMockProvider {
    fn new() -> Self {
        Self {
            submit_counter: std::sync::Mutex::new(0),
            confirmed_counter: std::sync::Mutex::new(0),
            unconfirmed_counter: std::sync::Mutex::new(0),
            should_submit_fail: false,
            tx_hash: H512::random(),
            confirmed_fixture: None,
            unconfirmed_fixture: None,
        }
    }

    fn with_submit_failure() -> Self {
        Self {
            should_submit_fail: true,
            ..Self::new()
        }
    }

    fn with_unconfirmed_then_finalized() -> Self {
        // Load fixtures from the test data directory
        let unconfirmed_data = std::fs::read_to_string(
            "src/adapter/chains/aleo/adapter/status/test_fixtures/unconfirmed_mempool.json",
        )
        .expect("Failed to read unconfirmed fixture");

        let confirmed_data = std::fs::read_to_string(
            "src/adapter/chains/aleo/adapter/status/test_fixtures/confirmed_accepted.json",
        )
        .expect("Failed to read confirmed fixture");

        Self {
            unconfirmed_fixture: Some(unconfirmed_data),
            confirmed_fixture: Some(confirmed_data),
            ..Self::new()
        }
    }
}

#[async_trait]
impl AleoProviderForLander for ConfigurableMockProvider {
    async fn submit_tx<I>(
        &self,
        _program_id: &str,
        _function_name: &str,
        _input: I,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = String> + Send,
        I::IntoIter: ExactSizeIterator,
    {
        let mut counter = self.submit_counter.lock().unwrap();
        *counter += 1;

        if self.should_submit_fail {
            Err(ChainCommunicationError::from_other_str(
                "Mock: Transaction submission failed",
            ))
        } else {
            Ok(self.tx_hash)
        }
    }

    async fn request_confirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoConfirmedTransaction<CurrentNetwork>> {
        let mut counter = self.confirmed_counter.lock().unwrap();
        *counter += 1;

        match &self.confirmed_fixture {
            Some(data) => {
                // Parse confirmed transaction from JSON fixture
                let tx: AleoConfirmedTransaction<CurrentNetwork> =
                    serde_json::from_str(data).expect("Failed to parse confirmed transaction");
                Ok(tx)
            }
            None => Err(ChainCommunicationError::from_other_str(
                "Transaction not confirmed yet",
            )),
        }
    }

    async fn request_unconfirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoUnconfirmedTransaction<CurrentNetwork>> {
        let mut counter = self.unconfirmed_counter.lock().unwrap();
        *counter += 1;

        match &self.unconfirmed_fixture {
            Some(data) => {
                // Parse unconfirmed transaction from JSON fixture
                let tx: AleoUnconfirmedTransaction<CurrentNetwork> =
                    serde_json::from_str(data).expect("Failed to parse unconfirmed transaction");
                Ok(tx)
            }
            None => Err(ChainCommunicationError::from_other_str(
                "Transaction not found",
            )),
        }
    }

    async fn mapping_value_exists(
        &self,
        _program_id: &str,
        _mapping_name: &str,
        _mapping_key: &hyperlane_aleo::Plaintext<hyperlane_aleo::CurrentNetwork>,
    ) -> ChainResult<bool> {
        Ok(false) // Default: messages not delivered
    }
}

/// Mock provider for testing specific Aleo error scenarios
/// These errors arise from actual Aleo transaction submission and should be handled appropriately
struct AleoErrorMockProvider {
    error_message: String,
    /// Number of times to return error before succeeding (for retryable errors)
    fail_count: std::sync::Mutex<usize>,
    max_failures: usize,
}

impl AleoErrorMockProvider {
    /// Create a provider that returns a retryable error a few times, then succeeds
    fn with_retryable_error(error_message: String, max_failures: usize) -> Self {
        Self {
            error_message,
            fail_count: std::sync::Mutex::new(0),
            max_failures,
        }
    }

    /// Create a provider that always returns the specified error
    fn with_permanent_error(error_message: String) -> Self {
        Self {
            error_message,
            fail_count: std::sync::Mutex::new(0),
            max_failures: usize::MAX,
        }
    }
}

#[async_trait]
impl AleoProviderForLander for AleoErrorMockProvider {
    async fn submit_tx<I>(
        &self,
        _program_id: &str,
        _function_name: &str,
        _input: I,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = String> + Send,
        I::IntoIter: ExactSizeIterator,
    {
        let mut count = self.fail_count.lock().unwrap();
        *count += 1;

        if *count <= self.max_failures {
            Err(ChainCommunicationError::from_other_str(&self.error_message))
        } else {
            Ok(H512::random())
        }
    }

    async fn request_confirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoConfirmedTransaction<CurrentNetwork>> {
        Err(ChainCommunicationError::from_other_str(
            "Mock provider: get_confirmed_transaction not implemented",
        ))
    }

    async fn request_unconfirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoUnconfirmedTransaction<CurrentNetwork>> {
        Err(ChainCommunicationError::from_other_str(
            "Mock provider: get_unconfirmed_transaction not implemented",
        ))
    }

    async fn mapping_value_exists(
        &self,
        _program_id: &str,
        _mapping_name: &str,
        _mapping_key: &hyperlane_aleo::Plaintext<hyperlane_aleo::CurrentNetwork>,
    ) -> ChainResult<bool> {
        Ok(false)
    }
}

#[tokio::test]
#[traced_test]
async fn test_aleo_inclusion_happy_path() {
    let block_time = Duration::from_millis(0); // Immediate resubmission for testing
    let mock_provider = ConfigurableMockProvider::with_unconfirmed_then_finalized();

    let expected_tx_states = vec![
        ExpectedAleoTxState {
            status: TransactionStatus::PendingInclusion,
            retries: 0,
        },
        ExpectedAleoTxState {
            status: TransactionStatus::Mempool,
            retries: 1,
        },
        ExpectedAleoTxState {
            status: TransactionStatus::Finalized,
            retries: 1,
        },
    ];

    run_and_expect_successful_inclusion(expected_tx_states, mock_provider, block_time).await;
}

#[tokio::test]
#[traced_test]
async fn test_aleo_inclusion_submission_failure_drops_tx() {
    let block_time = Duration::from_millis(0);
    let mock_provider = ConfigurableMockProvider::with_submit_failure();

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_aleo_tx(
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
async fn test_aleo_tx_ready_for_resubmission_block_time() {
    let block_time = TEST_BLOCK_TIME;
    let mock_provider = MockAleoProvider;

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);

    let mut created_txs = vec![
        mock_aleo_tx(
            &dispatcher_state.payload_db,
            &dispatcher_state.tx_db,
            TransactionStatus::PendingInclusion,
        )
        .await,
    ];
    let mut tx = created_txs.remove(0);

    let duration_since_epoch = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap();
    #[allow(deprecated)]
    let mock_last_submission_attempt = Utc.timestamp(
        duration_since_epoch.as_secs() as i64,
        duration_since_epoch.subsec_nanos(),
    );
    tx.last_submission_attempt = Some(mock_last_submission_attempt);

    // Ensure the transaction is not ready for resubmission immediately
    assert!(
        !dispatcher_state
            .adapter
            .tx_ready_for_resubmission(&tx)
            .await
    );

    // Simulate sufficient time passing
    tokio::time::sleep(block_time * 2).await;

    // Ensure the transaction is now ready for resubmission
    assert!(
        dispatcher_state
            .adapter
            .tx_ready_for_resubmission(&tx)
            .await
    );
}

// Tests for Aleo-specific error handling
// Based on: https://gist.github.com/iamalwaysuncomfortable/d79660cd609be50866fef16b05cbcde2

#[tokio::test]
#[traced_test]
async fn test_aleo_inclusion_retryable_error_rate_limit() {
    // Test that rate limiting errors are retried and eventually succeed
    let block_time = Duration::from_millis(0);
    let mock_provider = AleoErrorMockProvider::with_retryable_error(
        "Too many requests".to_string(),
        2, // Fail twice, then succeed
    );

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);
    let (finality_stage_sender, _finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_aleo_tx(
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
async fn test_aleo_inclusion_retryable_error_node_syncing() {
    // Test that node syncing errors are retried
    let block_time = Duration::from_millis(0);
    let mock_provider = AleoErrorMockProvider::with_retryable_error(
        "Unable to validate transaction (node is syncing)".to_string(),
        1, // Fail once, then succeed
    );

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);
    let (finality_stage_sender, _finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_aleo_tx(
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

    // First attempt should fail but not drop
    InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await
    .unwrap();

    assert!(
        inclusion_stage_pool
            .lock()
            .await
            .contains_key(&created_tx.uuid),
        "Transaction should remain in pool after node syncing error"
    );

    // Second attempt should succeed
    InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await
    .unwrap();

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
async fn test_aleo_inclusion_tx_already_exists_treated_as_success() {
    // Test that TxAlreadyExists is treated as success (tx proceeds to finality stage)
    let block_time = Duration::from_millis(0);
    let mock_provider = AleoErrorMockProvider::with_permanent_error(
        "Transaction 'at1xyz...' already exists in the ledger".to_string(),
    );

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);
    let (finality_stage_sender, _finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_aleo_tx(
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

    // Process should treat TxAlreadyExists as success
    let result = InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await;

    assert!(
        result.is_ok(),
        "TxAlreadyExists should be treated as success"
    );

    // Transaction status should be Mempool (successfully submitted)
    let retrieved_tx = dispatcher_state
        .tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(retrieved_tx.status, TransactionStatus::Mempool),
        "Transaction status should be Mempool when TxAlreadyExists, got: {:?}",
        retrieved_tx.status
    );

    // Transaction should remain in pool for status checking (not removed yet)
    assert!(
        inclusion_stage_pool
            .lock()
            .await
            .contains_key(&created_tx.uuid),
        "Transaction should remain in pool for status checking after TxAlreadyExists"
    );
}

#[tokio::test]
#[traced_test]
async fn test_aleo_inclusion_non_retryable_error_duplicate_input() {
    // Test that non-retryable errors (like duplicate inputs) drop the transaction
    let block_time = Duration::from_millis(0);
    let mock_provider = AleoErrorMockProvider::with_permanent_error(
        "Found a duplicate Input ID: 1234567890".to_string(),
    );

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_aleo_tx(
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

    // Process should drop the transaction
    let result = InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await;

    assert!(
        result.is_ok(),
        "Non-retryable error should be handled gracefully"
    );

    // Transaction should be removed from pool (dropped)
    assert!(
        inclusion_stage_pool.lock().await.is_empty(),
        "Transaction should be dropped after non-retryable error"
    );

    // Transaction should be marked as Dropped in DB
    let retrieved_tx = dispatcher_state
        .tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(retrieved_tx.status, TransactionStatus::Dropped(_)),
        "Transaction should be dropped for non-retryable error"
    );

    // No transaction should be sent to finality stage
    let maybe_tx = tokio::time::timeout(Duration::from_millis(100), finality_stage_receiver.recv())
        .await
        .ok()
        .flatten();
    assert!(
        maybe_tx.is_none(),
        "Dropped transaction should not reach finality stage"
    );
}

#[tokio::test]
#[traced_test]
async fn test_aleo_inclusion_non_retryable_error_transaction_size_exceeded() {
    // Test that transaction size limit errors drop the transaction
    let block_time = Duration::from_millis(0);
    let mock_provider = AleoErrorMockProvider::with_permanent_error(
        "Transaction size exceeds the byte limit".to_string(),
    );

    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);
    let (finality_stage_sender, _finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_aleo_tx(
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

    // Process should drop the transaction
    InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await
    .unwrap();

    // Verify transaction was dropped
    assert!(
        inclusion_stage_pool.lock().await.is_empty(),
        "Transaction should be dropped when size limit is exceeded"
    );

    let retrieved_tx = dispatcher_state
        .tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(retrieved_tx.status, TransactionStatus::Dropped(_)),
        "Transaction should be marked as dropped"
    );
}

async fn run_and_expect_successful_inclusion(
    expected_tx_states: Vec<ExpectedAleoTxState>,
    mock_provider: ConfigurableMockProvider,
    block_time: Duration,
) {
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, block_time);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_tx = mock_aleo_tx(
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

    let mut expected_iter = expected_tx_states.iter();
    let expected_tx_state = expected_iter.next().unwrap();
    assert_tx_db_state(expected_tx_state, &dispatcher_state.tx_db, &created_tx).await;

    for expected_tx_state in expected_iter {
        InclusionStage::process_txs_step(
            &inclusion_stage_pool,
            &finality_stage_sender,
            &dispatcher_state,
            mock_domain,
        )
        .await
        .unwrap();

        assert_tx_db_state(expected_tx_state, &dispatcher_state.tx_db, &created_tx).await;
    }

    // need to manually set this because panics don't propagate through the select! macro
    #[allow(unused_assignments)]
    let mut success = false;
    select! {
        tx_received = finality_stage_receiver.recv() => {
            let tx_received = tx_received.unwrap();
            assert_eq!(tx_received.payload_details[0].uuid, created_tx.payload_details[0].uuid);
            success = true;
        },
        _ = tokio::time::sleep(Duration::from_millis(5000)) => {}
    }
    assert!(
        success,
        "Inclusion stage did not process the txs successfully"
    );
}

fn mock_dispatcher_state_with_provider<P>(provider: P, block_time: Duration) -> DispatcherState
where
    P: AleoProviderForLander + 'static,
{
    let (payload_db, tx_db, _) = tmp_dbs();
    let adapter = AleoAdapter {
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

async fn mock_aleo_tx(
    payload_db: &Arc<dyn PayloadDb>,
    tx_db: &Arc<dyn TransactionDb>,
    status: TransactionStatus,
) -> Transaction {
    use uuid::Uuid;

    use hyperlane_aleo::AleoTxData;
    use hyperlane_core::H256;

    use crate::adapter::chains::AleoTxPrecursor;
    use crate::payload::PayloadDetails;
    use crate::transaction::VmSpecificTxData;
    use crate::{PayloadUuid, TransactionUuid};

    let tx_data = AleoTxData {
        program_id: "test_program.aleo".to_string(),
        function_name: "test_function".to_string(),
        inputs: vec!["input1".to_string(), "input2".to_string()],
    };

    let payload_uuid = PayloadUuid::random();
    let payload = FullPayload {
        details: PayloadDetails {
            uuid: payload_uuid.clone(),
            metadata: format!("test-payload-{}", payload_uuid),
            success_criteria: Some(vec![1, 2, 3, 4]),
        },
        data: serde_json::to_vec(&tx_data).unwrap(),
        to: H256::zero(),
        status: PayloadStatus::InTransaction(status.clone()),
        value: None,
        inclusion_soft_deadline: None,
    };

    payload_db.store_payload_by_uuid(&payload).await.unwrap();

    let precursor = AleoTxPrecursor {
        program_id: "test_program.aleo".to_string(),
        function_name: "test_function".to_string(),
        inputs: vec!["input1".to_string(), "input2".to_string()],
    };

    let tx = Transaction {
        uuid: TransactionUuid::new(Uuid::new_v4()),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Aleo(Box::new(precursor)),
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

async fn assert_tx_db_state(
    expected: &ExpectedAleoTxState,
    tx_db: &Arc<dyn TransactionDb>,
    created_tx: &Transaction,
) {
    let retrieved_tx = tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        retrieved_tx.status, expected.status,
        "Transaction status mismatch"
    );
    assert_eq!(
        retrieved_tx.payload_details, created_tx.payload_details,
        "Payload details mismatch"
    );
    assert_eq!(
        retrieved_tx.submission_attempts, expected.retries,
        "Submission attempts mismatch"
    );
}
