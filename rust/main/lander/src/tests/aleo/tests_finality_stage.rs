use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tracing_test::traced_test;

use hyperlane_aleo::{
    AleoConfirmedTransaction, AleoProviderForLander, AleoSerialize, AleoUnconfirmedTransaction,
    CurrentNetwork, DeliveryKey,
};
use hyperlane_core::{ChainCommunicationError, ChainResult, H512};

use crate::adapter::chains::AleoAdapter;
use crate::dispatcher::{BuildingStageQueue, DispatcherState, FinalityStage, FinalityStagePool};
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::Transaction;
use crate::{DispatcherMetrics, PayloadStatus, TransactionStatus};

const TEST_BLOCK_TIME: Duration = Duration::from_millis(10);

/// Mock provider that simulates success criteria checks
struct MockAleoProviderForFinality {
    /// Whether the success criteria check should succeed
    success_criteria_passes: bool,
}

impl MockAleoProviderForFinality {
    fn with_success() -> Self {
        Self {
            success_criteria_passes: true,
        }
    }

    fn with_failure() -> Self {
        Self {
            success_criteria_passes: false,
        }
    }
}

#[async_trait]
impl AleoProviderForLander for MockAleoProviderForFinality {
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
        Ok(H512::random())
    }

    async fn get_confirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoConfirmedTransaction<CurrentNetwork>> {
        Err(ChainCommunicationError::from_other_str(
            "Mock provider: get_confirmed_transaction not implemented",
        ))
    }

    async fn get_unconfirmed_transaction(
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
        // Return based on the configured success criteria result
        Ok(self.success_criteria_passes)
    }
}

#[tokio::test]
#[traced_test]
async fn test_aleo_tx_finalized_happy_path() {
    let mock_provider = MockAleoProviderForFinality::with_success();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, TEST_BLOCK_TIME);
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let mut created_tx = mock_aleo_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::Finalized,
    )
    .await;

    // Add a transaction hash to simulate that it was submitted
    created_tx.tx_hashes.push(H512::random());

    // Add success_criteria to the payload
    created_tx.payload_details.iter_mut().for_each(|detail| {
        let delivery_key = DeliveryKey { id: [1u128, 1u128] };
        let get_mapping_value = hyperlane_aleo::AleoGetMappingValue {
            program_id: "mailbox.aleo".to_string(),
            mapping_name: "deliveries".to_string(),
            mapping_key: delivery_key.to_plaintext().unwrap(),
        };
        detail.success_criteria = Some(serde_json::to_vec(&get_mapping_value).unwrap());
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
async fn test_aleo_tx_finalized_but_failed() {
    let mock_provider = MockAleoProviderForFinality::with_failure();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, TEST_BLOCK_TIME);
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let mut created_tx = mock_aleo_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::Finalized,
    )
    .await;

    // Add a transaction hash to simulate that it was submitted
    created_tx.tx_hashes.push(H512::random());

    // Add success_criteria to the payload
    created_tx.payload_details.iter_mut().for_each(|detail| {
        let delivery_key = DeliveryKey { id: [1u128, 1u128] };
        let get_mapping_value = hyperlane_aleo::AleoGetMappingValue {
            program_id: "mailbox.aleo".to_string(),
            mapping_name: "deliveries".to_string(),
            mapping_key: delivery_key.to_plaintext().unwrap(),
        };
        detail.success_criteria = Some(serde_json::to_vec(&get_mapping_value).unwrap());
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
    // The mock provider returns false for mapping_value_exists, indicating the message was not delivered
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
                PayloadStatus::Dropped(crate::PayloadDropReason::Reverted)
            ),
            "Payload should be marked as reverted when success criteria check fails (not delivered on-chain)"
        );
    }
}

#[tokio::test]
#[traced_test]
async fn test_aleo_tx_finalized_without_success_criteria() {
    let mock_provider = MockAleoProviderForFinality::with_success();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, TEST_BLOCK_TIME);
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let mut created_tx = mock_aleo_tx(
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
async fn test_aleo_tx_finalized_invalid_success_criteria() {
    // NOTE: This scenario is unlikely in practice since success_criteria creation is controlled by our code.
    // However, we test it to ensure proper error handling if malformed data is ever stored.
    let mock_provider = MockAleoProviderForFinality::with_success();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_provider, TEST_BLOCK_TIME);
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let mut created_tx = mock_aleo_tx(
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::Finalized,
    )
    .await;

    // Add a transaction hash to simulate that it was submitted
    created_tx.tx_hashes.push(H512::random());

    // Set invalid success_criteria (not valid JSON for AleoGetMappingValue)
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

    // Should return an error when parsing fails
    assert!(
        result.is_err(),
        "Processing tx with invalid success criteria should fail"
    );

    // Verify the error message indicates parsing failure
    let error_msg = result.unwrap_err().to_string();
    assert!(
        error_msg.contains("Failed to parse success_criteria"),
        "Error should indicate parsing failure, got: {}",
        error_msg
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
    payload_db: &Arc<dyn crate::dispatcher::PayloadDb>,
    tx_db: &Arc<dyn crate::dispatcher::TransactionDb>,
    status: TransactionStatus,
) -> Transaction {
    use uuid::Uuid;

    use hyperlane_aleo::AleoTxData;
    use hyperlane_core::H256;

    use crate::adapter::chains::AleoTxPrecursor;
    use crate::payload::PayloadDetails;
    use crate::transaction::VmSpecificTxData;
    use crate::{FullPayload, PayloadStatus, PayloadUuid, TransactionUuid};

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
            success_criteria: None, // Set by tests as needed
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
