use core::panic;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ethers::types::{
    transaction::eip2718::TypedTransaction, Address, Bloom, Eip1559TransactionRequest,
    TransactionReceipt, H160, U64,
};

use hyperlane_core::{H512, U256};

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

/// Tests that post_finalized triggers nonce boundary updates on the Ethereum adapter.
/// This integration test uses the real EthereumAdapter with a mocked provider to verify
/// that when a transaction is finalized, the adapter's post_finalized method is called
/// and correctly triggers nonce boundary updates via the NonceUpdater.
#[tokio::test]
#[tracing_test::traced_test]
async fn test_post_finalized_triggers_nonce_update() {
    let block_time = TEST_BLOCK_TIME;

    // Counter to track how many times get_next_nonce_on_finalized_block is called
    let nonce_query_count = Arc::new(AtomicUsize::new(0));
    let nonce_query_count_clone = nonce_query_count.clone();

    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_default_fee_history(&mut mock_evm_provider);

    // Track calls to get_next_nonce_on_finalized_block
    mock_evm_provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(move |_, _| {
            nonce_query_count_clone.fetch_add(1, Ordering::SeqCst);
            Ok(U256::one())
        });

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

    // Record initial nonce query count (there may be calls during setup)
    let initial_count = nonce_query_count.load(Ordering::SeqCst);

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

    // Verify that get_next_nonce_on_finalized_block was called at least once after
    // the initial setup, which indicates post_finalized triggered the nonce update
    let final_count = nonce_query_count.load(Ordering::SeqCst);
    assert!(
        final_count > initial_count,
        "post_finalized should trigger nonce boundary update. Initial count: {}, Final count: {}",
        initial_count,
        final_count
    );

    // Also verify the transaction was finalized correctly
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
