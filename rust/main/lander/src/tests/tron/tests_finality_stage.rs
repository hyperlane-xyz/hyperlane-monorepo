use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::abi::{Detokenize, Function, Token};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::U256;
use tracing_test::traced_test;

use hyperlane_core::{ChainCommunicationError, ChainResult, H256, H512};
use hyperlane_tron::TronProviderForLander;

use crate::adapter::chains::tron::{TronAdapter, TronTxPrecursor};
use crate::dispatcher::{BuildingStageQueue, DispatcherState, FinalityStage, FinalityStagePool};
use crate::payload::PayloadDetails;
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{Transaction, VmSpecificTxData};
use crate::{
    DispatcherMetrics, FullPayload, PayloadDropReason, PayloadStatus, PayloadUuid,
    TransactionStatus, TransactionUuid,
};

use super::test_utils::{create_test_function, create_test_tx_request};

const TEST_BLOCK_TIME: Duration = Duration::from_millis(10);

/// Mock provider that simulates success criteria checks for finality stage
struct MockTronProviderForFinality {
    /// Whether the success criteria check should succeed
    success_criteria_passes: bool,
    /// Whether the call should return an error
    should_error: bool,
}

impl MockTronProviderForFinality {
    fn with_success() -> Self {
        Self {
            success_criteria_passes: true,
            should_error: false,
        }
    }

    fn with_failure() -> Self {
        Self {
            success_criteria_passes: false,
            should_error: false,
        }
    }

    fn with_error() -> Self {
        Self {
            success_criteria_passes: false,
            should_error: true,
        }
    }
}

#[async_trait]
impl TronProviderForLander for MockTronProviderForFinality {
    async fn get_transaction_receipt(
        &self,
        _transaction_hash: H512,
    ) -> ChainResult<Option<ethers::types::TransactionReceipt>> {
        Ok(None)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(100)
    }

    async fn submit_tx(&self, _tx: &TypedTransaction) -> ChainResult<H256> {
        Ok(H256::random())
    }

    async fn estimate_gas(&self, _tx: &TypedTransaction) -> ChainResult<U256> {
        Ok(U256::from(21_000))
    }

    async fn call<T: Detokenize>(
        &self,
        _tx: &TypedTransaction,
        _function: &Function,
    ) -> ChainResult<T> {
        if self.should_error {
            return Err(ChainCommunicationError::from_other_str(
                "Mock provider: call failed",
            ));
        }

        // Return based on the configured success criteria result
        let token = Token::Bool(self.success_criteria_passes);
        T::from_tokens(vec![token]).map_err(|e| {
            ChainCommunicationError::from_other_str(&format!("Failed to decode token: {}", e))
        })
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
    payload_db: &Arc<dyn crate::dispatcher::PayloadDb>,
    tx_db: &Arc<dyn crate::dispatcher::TransactionDb>,
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

#[tokio::test]
#[traced_test]
async fn test_tron_tx_finalized_happy_path() {
    let mock_provider = MockTronProviderForFinality::with_success();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, TEST_BLOCK_TIME);
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let mut created_tx = mock_tron_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::Finalized,
    )
    .await;

    // Add a transaction hash to simulate that it was submitted
    created_tx.tx_hashes.push(H512::random());

    // Add success_criteria to the payload - for Tron this is (TypedTransaction, Function) pair
    let precursor = create_test_precursor();
    let success_criteria = serde_json::to_vec(&(&precursor.tx, &precursor.function))
        .expect("Failed to serialize success criteria");

    created_tx.payload_details.iter_mut().for_each(|detail| {
        detail.success_criteria = Some(success_criteria.clone());
    });

    let result = FinalityStage::try_process_tx(
        created_tx.clone(),
        finality_stage_pool.clone(),
        building_stage_queue,
        &dispatcher_state,
    )
    .await;
    assert!(result.is_ok(), "Processing finalized tx should succeed");

    // Verify payload is still finalized (success criteria passed)
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
                PayloadStatus::InTransaction(TransactionStatus::Finalized)
            ),
            "Payload should remain finalized when success criteria passes"
        );
    }
}

#[tokio::test]
#[traced_test]
async fn test_tron_tx_finalized_but_failed() {
    let mock_provider = MockTronProviderForFinality::with_failure();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, TEST_BLOCK_TIME);
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let mut created_tx = mock_tron_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::Finalized,
    )
    .await;

    // Add a transaction hash to simulate that it was submitted
    created_tx.tx_hashes.push(H512::random());

    // Add success_criteria to the payload
    let precursor = create_test_precursor();
    let success_criteria = serde_json::to_vec(&(&precursor.tx, &precursor.function))
        .expect("Failed to serialize success criteria");

    created_tx.payload_details.iter_mut().for_each(|detail| {
        detail.success_criteria = Some(success_criteria.clone());
    });

    let result = FinalityStage::try_process_tx(
        created_tx.clone(),
        finality_stage_pool.clone(),
        building_stage_queue,
        &dispatcher_state,
    )
    .await;
    assert!(result.is_ok(), "Processing finalized tx should succeed");

    // Verify payloads are marked as reverted (success criteria check failed)
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
                PayloadStatus::Dropped(PayloadDropReason::Reverted)
            ),
            "Payload should be marked as reverted when success criteria check fails"
        );
    }
}

#[tokio::test]
#[traced_test]
async fn test_tron_tx_finalized_without_success_criteria() {
    let mock_provider = MockTronProviderForFinality::with_success();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, TEST_BLOCK_TIME);
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let mut created_tx = mock_tron_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::Finalized,
    )
    .await;

    // Add a transaction hash to simulate that it was submitted
    created_tx.tx_hashes.push(H512::random());

    // No success_criteria set - payload should remain finalized without checks
    assert!(created_tx.payload_details[0].success_criteria.is_none());

    let result = FinalityStage::try_process_tx(
        created_tx.clone(),
        finality_stage_pool.clone(),
        building_stage_queue,
        &dispatcher_state,
    )
    .await;
    assert!(
        result.is_ok(),
        "Processing finalized tx without success criteria should succeed"
    );

    // Verify payload remains finalized (no criteria to check)
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
                PayloadStatus::InTransaction(TransactionStatus::Finalized)
            ),
            "Payload should remain finalized when no success criteria is set"
        );
    }
}

#[tokio::test]
#[traced_test]
async fn test_tron_tx_finalized_invalid_success_criteria() {
    // NOTE: This scenario tests error handling for malformed success_criteria data
    let mock_provider = MockTronProviderForFinality::with_success();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, TEST_BLOCK_TIME);
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let mut created_tx = mock_tron_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::Finalized,
    )
    .await;

    // Add a transaction hash to simulate that it was submitted
    created_tx.tx_hashes.push(H512::random());

    // Set invalid success_criteria (not valid JSON for (TypedTransaction, Function))
    created_tx.payload_details.iter_mut().for_each(|detail| {
        detail.success_criteria = Some(vec![0xFF, 0xFE, 0xFD]); // Invalid UTF-8/JSON bytes
    });

    let result = FinalityStage::try_process_tx(
        created_tx.clone(),
        finality_stage_pool.clone(),
        building_stage_queue,
        &dispatcher_state,
    )
    .await;

    // The result should be an error since from_data() returns Result with invalid data
    assert!(
        result.is_err(),
        "Processing tx with invalid success criteria should fail"
    );
}

#[tokio::test]
#[traced_test]
async fn test_tron_tx_finalized_call_error() {
    // Test that provider errors during success criteria check are handled
    let mock_provider = MockTronProviderForFinality::with_error();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, TEST_BLOCK_TIME);
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let mut created_tx = mock_tron_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::Finalized,
    )
    .await;

    // Add a transaction hash to simulate that it was submitted
    created_tx.tx_hashes.push(H512::random());

    // Add success_criteria to trigger the call
    let precursor = create_test_precursor();
    let success_criteria = serde_json::to_vec(&(&precursor.tx, &precursor.function))
        .expect("Failed to serialize success criteria");

    created_tx.payload_details.iter_mut().for_each(|detail| {
        detail.success_criteria = Some(success_criteria.clone());
    });

    let result = FinalityStage::try_process_tx(
        created_tx.clone(),
        finality_stage_pool.clone(),
        building_stage_queue,
        &dispatcher_state,
    )
    .await;

    // Provider errors should propagate
    assert!(
        result.is_err(),
        "Processing tx when provider call fails should return error"
    );
}

#[tokio::test]
#[traced_test]
async fn test_tron_tx_finalized_multiple_payloads_mixed_results() {
    // Test scenario where some payloads pass success criteria and some fail
    // This tests the partial revert scenario

    // Create a custom provider that returns different results based on call count
    struct MixedResultProvider {
        call_count: std::sync::Mutex<u32>,
    }

    #[async_trait]
    impl TronProviderForLander for MixedResultProvider {
        async fn get_transaction_receipt(
            &self,
            _transaction_hash: H512,
        ) -> ChainResult<Option<ethers::types::TransactionReceipt>> {
            Ok(None)
        }

        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            Ok(100)
        }

        async fn submit_tx(&self, _tx: &TypedTransaction) -> ChainResult<H256> {
            Ok(H256::random())
        }

        async fn estimate_gas(&self, _tx: &TypedTransaction) -> ChainResult<U256> {
            Ok(U256::from(21_000))
        }

        async fn call<T: Detokenize>(
            &self,
            _tx: &TypedTransaction,
            _function: &Function,
        ) -> ChainResult<T> {
            let mut count = self.call_count.lock().unwrap();
            *count += 1;
            // First call succeeds, second call fails
            let success = *count == 1;
            let token = Token::Bool(success);
            T::from_tokens(vec![token]).map_err(|e| {
                ChainCommunicationError::from_other_str(&format!("Failed to decode token: {}", e))
            })
        }
    }

    let mock_provider = MixedResultProvider {
        call_count: std::sync::Mutex::new(0),
    };
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, TEST_BLOCK_TIME);
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    // Create a transaction with multiple payloads
    let precursor = create_test_precursor();
    let success_criteria = serde_json::to_vec(&(&precursor.tx, &precursor.function))
        .expect("Failed to serialize success criteria");

    let payload1_uuid = PayloadUuid::random();
    let payload2_uuid = PayloadUuid::random();

    let payload1 = FullPayload {
        details: PayloadDetails {
            uuid: payload1_uuid.clone(),
            metadata: "payload-1".to_string(),
            success_criteria: Some(success_criteria.clone()),
        },
        data: serde_json::to_vec(&(&precursor.tx, &precursor.function)).unwrap(),
        to: H256::zero(),
        status: PayloadStatus::InTransaction(TransactionStatus::Finalized),
        value: None,
        inclusion_soft_deadline: None,
    };

    let payload2 = FullPayload {
        details: PayloadDetails {
            uuid: payload2_uuid.clone(),
            metadata: "payload-2".to_string(),
            success_criteria: Some(success_criteria.clone()),
        },
        data: serde_json::to_vec(&(&precursor.tx, &precursor.function)).unwrap(),
        to: H256::zero(),
        status: PayloadStatus::InTransaction(TransactionStatus::Finalized),
        value: None,
        inclusion_soft_deadline: None,
    };

    dispatcher_state
        .payload_db
        .store_payload_by_uuid(&payload1)
        .await
        .unwrap();
    dispatcher_state
        .payload_db
        .store_payload_by_uuid(&payload2)
        .await
        .unwrap();

    let tx = Transaction {
        uuid: TransactionUuid::new(uuid::Uuid::new_v4()),
        tx_hashes: vec![H512::random()],
        vm_specific_data: VmSpecificTxData::Tron(Box::new(precursor)),
        payload_details: vec![payload1.details.clone(), payload2.details.clone()],
        status: TransactionStatus::Finalized,
        submission_attempts: 1,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
        last_status_check: None,
    };

    dispatcher_state
        .tx_db
        .store_transaction_by_uuid(&tx)
        .await
        .unwrap();

    let result = FinalityStage::try_process_tx(
        tx.clone(),
        finality_stage_pool.clone(),
        building_stage_queue,
        &dispatcher_state,
    )
    .await;
    assert!(result.is_ok(), "Processing should succeed");

    // First payload should remain finalized (success criteria passed)
    let p1 = dispatcher_state
        .payload_db
        .retrieve_payload_by_uuid(&payload1_uuid)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(
            p1.status,
            PayloadStatus::InTransaction(TransactionStatus::Finalized)
        ),
        "First payload should remain finalized, got: {:?}",
        p1.status
    );

    // Second payload should be reverted (success criteria failed)
    let p2 = dispatcher_state
        .payload_db
        .retrieve_payload_by_uuid(&payload2_uuid)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(
            p2.status,
            PayloadStatus::Dropped(PayloadDropReason::Reverted)
        ),
        "Second payload should be reverted, got: {:?}",
        p2.status
    );
}
