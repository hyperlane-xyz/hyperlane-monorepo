use core::panic;
use ethers::types::{
    transaction::eip2718::TypedTransaction, Address, Bloom, Eip1559TransactionRequest,
    TransactionReceipt, H160, U64,
};
use hyperlane_core::H512;
use std::time::Duration;

use crate::adapter::chains::ethereum::tests::{
    dummy_evm_function, ExpectedTxType, MockEvmProvider,
};
use crate::dispatcher::{BuildingStageQueue, FinalityStage, FinalityStagePool};
use crate::{PayloadDropReason, PayloadStatus, TransactionStatus};

use super::test_utils::*;

/// This is block time for unit tests which assume that we are ready to re-submit every time,
/// so, it is set to 0 nanoseconds so that we can test the inclusion stage without waiting
const TEST_BLOCK_TIME: Duration = Duration::from_nanos(0);
const TEST_MINIMUM_TIME_BETWEEN_RESUBMISSIONS: Duration = Duration::from_nanos(0);

#[tokio::test]
#[tracing_test::traced_test]
async fn test_tx_finalized_happy_path() {
    let block_time = TEST_BLOCK_TIME;

    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_default_fee_history(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);

    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(|_| {
            Ok(Some(TransactionReceipt {
                transaction_hash: ethers::types::H256::random(),
                transaction_index: U64::one(),
                block_hash: Some(ethers::types::H256::random()),
                block_number: Some(U64::one()),
                from: Address::random(),
                to: None,
                cumulative_gas_used: ethers::types::U256::one(),
                gas_used: Some(ethers::types::U256::one()),
                contract_address: Some(Address::random()),
                logs: Vec::new(),
                status: Some(U64::one()),
                root: Some(ethers::types::H256::random()),
                logs_bloom: Bloom::default(),
                transaction_type: Some(U64::one()),
                effective_gas_price: Some(ethers::types::U256::one()),
                ..Default::default()
            }))
        });
    // success criteria should succeed
    mock_evm_provider.expect_check().returning(|_, _| Ok(true));

    let signer = H160::random();
    let dispatcher_state = mock_dispatcher_state_with_provider(
        mock_evm_provider,
        signer,
        block_time,
        TEST_MINIMUM_TIME_BETWEEN_RESUBMISSIONS,
    );
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let created_txs = mock_evm_txs(
        1,
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::Finalized,
        signer,
        ExpectedTxType::Eip1559,
    )
    .await;

    let mut created_tx = created_txs[0].clone();
    created_tx.tx_hashes.push(H512::random());
    created_tx.payload_details.iter_mut().for_each(|detail| {
        let data = (
            TypedTransaction::Eip1559(Eip1559TransactionRequest::default()),
            dummy_evm_function(),
        );
        detail.success_criteria = Some(serde_json::to_vec(&data).unwrap());
    });

    let result = FinalityStage::try_process_tx(
        created_tx.clone(),
        finality_stage_pool.clone(),
        building_stage_queue,
        &dispatcher_state,
    )
    .await;
    assert!(result.is_ok());

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
            "Payload should be finalized"
        );
    }
}

#[tokio::test]
#[tracing_test::traced_test]
async fn test_tx_finalized_but_failed() {
    let block_time = TEST_BLOCK_TIME;

    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_default_fee_history(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);

    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(|_| {
            Ok(Some(TransactionReceipt {
                transaction_hash: ethers::types::H256::random(),
                transaction_index: U64::one(),
                block_hash: Some(ethers::types::H256::random()),
                block_number: Some(U64::one()),
                from: Address::random(),
                to: None,
                cumulative_gas_used: ethers::types::U256::one(),
                gas_used: Some(ethers::types::U256::one()),
                contract_address: Some(Address::random()),
                logs: Vec::new(),
                status: Some(U64::zero()),
                root: Some(ethers::types::H256::random()),
                logs_bloom: Bloom::default(),
                transaction_type: Some(U64::one()),
                effective_gas_price: Some(ethers::types::U256::one()),
                ..Default::default()
            }))
        });
    // success criteria should fail
    mock_evm_provider.expect_check().returning(|_, _| Ok(false));

    let signer = H160::random();
    let dispatcher_state = mock_dispatcher_state_with_provider(
        mock_evm_provider,
        signer,
        block_time,
        TEST_MINIMUM_TIME_BETWEEN_RESUBMISSIONS,
    );
    let building_stage_queue = BuildingStageQueue::new();
    let finality_stage_pool = FinalityStagePool::new();

    let created_txs = mock_evm_txs(
        1,
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::Finalized,
        signer,
        ExpectedTxType::Eip1559,
    )
    .await;

    let mut created_tx = created_txs[0].clone();
    created_tx.tx_hashes.push(H512::random());
    created_tx.payload_details.iter_mut().for_each(|detail| {
        let data = (
            TypedTransaction::Eip1559(Eip1559TransactionRequest::default()),
            dummy_evm_function(),
        );
        detail.success_criteria = Some(serde_json::to_vec(&data).unwrap());
    });

    let result = FinalityStage::try_process_tx(
        created_tx.clone(),
        finality_stage_pool.clone(),
        building_stage_queue,
        &dispatcher_state,
    )
    .await;
    assert!(result.is_ok());

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
            "Payload should be reverted"
        );
    }
}
