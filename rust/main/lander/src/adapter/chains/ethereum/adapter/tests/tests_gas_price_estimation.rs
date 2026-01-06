use std::sync::Arc;
use std::time::Duration;

use ethers::types::{
    transaction::{eip2718::TypedTransaction, eip2930::AccessList},
    Eip1559TransactionRequest, H160,
};
use hyperlane_core::U256;

use crate::adapter::chains::ethereum::gas_price::GasPrice;
use crate::adapter::chains::ethereum::tests::{dummy_evm_tx, ExpectedTxType, MockEvmProvider};
use crate::adapter::{chains::ethereum::EthereumAdapter, AdaptsChain};
use crate::tests::evm::test_utils::{
    mock_default_fee_history, mock_ethereum_adapter, mock_fee_history, mock_finalized_block_number,
    mock_get_block,
};
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{DropReason, TransactionStatus, VmSpecificTxData};

/// Helper to create a transaction with a specific status and existing gas price
fn tx_with_status_and_gas_price(status: TransactionStatus) -> crate::transaction::Transaction {
    let signer = H160::random();
    let mut tx = dummy_evm_tx(ExpectedTxType::Eip1559, vec![], status, signer);

    // Set existing gas price to simulate a transaction that has been submitted before
    if let VmSpecificTxData::Evm(ethereum_tx_precursor) = &mut tx.vm_specific_data {
        ethereum_tx_precursor.tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(signer),
            to: Some(H160::random().into()),
            nonce: Some(ethers::types::U256::from(1)),
            gas: Some(ethers::types::U256::from(21000)),
            max_fee_per_gas: Some(ethers::types::U256::from(100000)), // 100,000 gwei (old price)
            max_priority_fee_per_gas: Some(ethers::types::U256::from(1000)), // 1,000 gwei (old price)
            value: Some(0.into()),
            data: None,
            access_list: AccessList::default(),
            chain_id: Some(1.into()),
        });
    }

    tx
}

/// Helper to setup mocked provider with specific gas price estimates
fn setup_mock_provider_with_gas_estimate(
    base_fee: u32,
    priority_fee: u32,
) -> (
    EthereumAdapter,
    Arc<dyn crate::dispatcher::PayloadDb>,
    Arc<dyn crate::dispatcher::TransactionDb>,
) {
    use crate::tests::evm::test_utils::mock_block;
    let mut provider = MockEvmProvider::new();

    mock_finalized_block_number(&mut provider);

    // Mock get_block to return a block with the specified base_fee
    // The eip1559_default_estimator formula is: max_fee = 2 * base_fee + max_priority_fee
    provider
        .expect_get_block()
        .returning(move |_| Ok(Some(mock_block(42, base_fee))));

    // Mock fee history with specific values to allow escalation testing
    // base_fee and priority_fee are in gwei
    provider
        .expect_fee_history()
        .returning(move |_, _, _| Ok(mock_fee_history(base_fee, priority_fee)));

    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(move |_, _| Ok(hyperlane_core::U256::from(1u64)));

    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let signer = H160::random();
    let block_time = Duration::from_secs(1);
    let minimum_time_between_resubmissions = Duration::from_millis(100);

    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    (adapter, payload_db, tx_db)
}

#[tokio::test]
async fn test_gas_escalation_applied_for_mempool_status() {
    // Use lower base_fee to ensure escalation kicks in
    let (adapter, _, _) = setup_mock_provider_with_gas_estimate(25000, 100);
    let tx = tx_with_status_and_gas_price(TransactionStatus::Mempool);

    let result = adapter.estimate_gas_price(&tx).await;
    assert!(result.is_ok());

    let new_gas_price = result.unwrap();

    // With Mempool status, escalation should be applied
    // The eip1559_default_estimator calculates values based on base_fee and fee_history
    // Old max_fee = 100,000, escalated = 110,000
    // Result should be >= old_escalated due to escalation being applied
    match new_gas_price {
        GasPrice::Eip1559 {
            max_fee,
            max_priority_fee,
        } => {
            // For Mempool status, escalation is applied, so the result should be
            // at least the escalated old price (110,000)
            assert!(
                max_fee >= U256::from(110000),
                "Gas price should be escalated for Mempool status, expected >= 110000, got {}",
                max_fee
            );
            assert!(
                max_priority_fee >= U256::from(1100),
                "Priority fee should be escalated for Mempool status, expected >= 1100, got {}",
                max_priority_fee
            );
        }
        _ => panic!("Expected Eip1559 gas price"),
    }
}

#[tokio::test]
async fn test_no_gas_escalation_for_pending_inclusion_status() {
    // Use low base_fee so fresh estimate is lower than escalated old price
    // Old price: 100,000, escalated: 110,000
    // We want fresh estimate < 110,000 to see the difference
    let (adapter, _, _) = setup_mock_provider_with_gas_estimate(10000, 100);

    // Create two transactions with the same initial gas price
    let tx_mempool = tx_with_status_and_gas_price(TransactionStatus::Mempool);
    let tx_pending = tx_with_status_and_gas_price(TransactionStatus::PendingInclusion);

    let result_mempool = adapter.estimate_gas_price(&tx_mempool).await.unwrap();
    let result_pending = adapter.estimate_gas_price(&tx_pending).await.unwrap();

    // With PendingInclusion status, escalation should NOT be applied
    // So the gas price should be less than Mempool (which has escalation)
    match (result_mempool, result_pending) {
        (
            GasPrice::Eip1559 {
                max_fee: mempool_max_fee,
                max_priority_fee: mempool_priority,
            },
            GasPrice::Eip1559 {
                max_fee: pending_max_fee,
                max_priority_fee: pending_priority,
            },
        ) => {
            // PendingInclusion should have lower or equal gas price than Mempool
            // because Mempool applies escalation while PendingInclusion doesn't
            assert!(
                pending_max_fee < mempool_max_fee,
                "PendingInclusion should NOT escalate: pending={}, mempool={}",
                pending_max_fee,
                mempool_max_fee
            );
            assert!(
                pending_priority < mempool_priority,
                "PendingInclusion priority fee should NOT escalate: pending={}, mempool={}",
                pending_priority,
                mempool_priority
            );
        }
        _ => panic!("Expected Eip1559 gas prices"),
    }
}

#[tokio::test]
async fn test_no_gas_escalation_for_included_status() {
    // Use low base_fee so fresh estimate is lower than escalated old price
    let (adapter, _, _) = setup_mock_provider_with_gas_estimate(10000, 100);

    let tx_mempool = tx_with_status_and_gas_price(TransactionStatus::Mempool);
    let tx_included = tx_with_status_and_gas_price(TransactionStatus::Included);

    let result_mempool = adapter.estimate_gas_price(&tx_mempool).await.unwrap();
    let result_included = adapter.estimate_gas_price(&tx_included).await.unwrap();

    // Included status should NOT apply escalation
    match (result_mempool, result_included) {
        (
            GasPrice::Eip1559 {
                max_fee: mempool_max_fee,
                max_priority_fee: mempool_priority,
            },
            GasPrice::Eip1559 {
                max_fee: included_max_fee,
                max_priority_fee: included_priority,
            },
        ) => {
            assert!(
                included_max_fee < mempool_max_fee,
                "Included should NOT escalate: included={}, mempool={}",
                included_max_fee,
                mempool_max_fee
            );
            assert!(
                included_priority < mempool_priority,
                "Included priority fee should NOT escalate"
            );
        }
        _ => panic!("Expected Eip1559 gas prices"),
    }
}

#[tokio::test]
async fn test_no_gas_escalation_for_finalized_status() {
    // Use low base_fee so fresh estimate is lower than escalated old price
    let (adapter, _, _) = setup_mock_provider_with_gas_estimate(10000, 100);

    let tx_mempool = tx_with_status_and_gas_price(TransactionStatus::Mempool);
    let tx_finalized = tx_with_status_and_gas_price(TransactionStatus::Finalized);

    let result_mempool = adapter.estimate_gas_price(&tx_mempool).await.unwrap();
    let result_finalized = adapter.estimate_gas_price(&tx_finalized).await.unwrap();

    // Finalized status should NOT apply escalation
    match (result_mempool, result_finalized) {
        (
            GasPrice::Eip1559 {
                max_fee: mempool_max_fee,
                max_priority_fee: mempool_priority,
            },
            GasPrice::Eip1559 {
                max_fee: finalized_max_fee,
                max_priority_fee: finalized_priority,
            },
        ) => {
            assert!(
                finalized_max_fee < mempool_max_fee,
                "Finalized should NOT escalate: finalized={}, mempool={}",
                finalized_max_fee,
                mempool_max_fee
            );
            assert!(
                finalized_priority < mempool_priority,
                "Finalized priority fee should NOT escalate"
            );
        }
        _ => panic!("Expected Eip1559 gas prices"),
    }
}

#[tokio::test]
async fn test_no_gas_escalation_for_dropped_status() {
    // Use low base_fee so fresh estimate is lower than escalated old price
    let (adapter, _, _) = setup_mock_provider_with_gas_estimate(10000, 100);

    let tx_mempool = tx_with_status_and_gas_price(TransactionStatus::Mempool);
    let tx_dropped = tx_with_status_and_gas_price(TransactionStatus::Dropped(DropReason::Other(
        "Test reason".to_string(),
    )));

    let result_mempool = adapter.estimate_gas_price(&tx_mempool).await.unwrap();
    let result_dropped = adapter.estimate_gas_price(&tx_dropped).await.unwrap();

    // Dropped status should NOT apply escalation
    match (result_mempool, result_dropped) {
        (
            GasPrice::Eip1559 {
                max_fee: mempool_max_fee,
                max_priority_fee: mempool_priority,
            },
            GasPrice::Eip1559 {
                max_fee: dropped_max_fee,
                max_priority_fee: dropped_priority,
            },
        ) => {
            assert!(
                dropped_max_fee < mempool_max_fee,
                "Dropped should NOT escalate: dropped={}, mempool={}",
                dropped_max_fee,
                mempool_max_fee
            );
            assert!(
                dropped_priority < mempool_priority,
                "Dropped priority fee should NOT escalate"
            );
        }
        _ => panic!("Expected Eip1559 gas prices"),
    }
}

#[tokio::test]
async fn test_gas_escalation_uses_higher_estimated_price_for_mempool() {
    // Set up provider with higher estimated gas price than old price
    let (adapter, _, _) = setup_mock_provider_with_gas_estimate(100000, 2000);
    let tx = tx_with_status_and_gas_price(TransactionStatus::Mempool);

    let result = adapter.estimate_gas_price(&tx).await;
    assert!(result.is_ok());

    let new_gas_price = result.unwrap();

    // With Mempool status and higher estimated base fee:
    // The escalated old price is 110,000 (100,000 * 1.1)
    // But if the fresh estimate is higher, it should use that instead
    // Verify that the result is higher than the escalated old price
    match new_gas_price {
        GasPrice::Eip1559 {
            max_fee,
            max_priority_fee,
        } => {
            // Should be at least the escalated old price
            assert!(
                max_fee >= U256::from(110000),
                "Should use higher estimated price even with escalation for Mempool"
            );
            assert!(
                max_priority_fee >= U256::from(1100),
                "Should use higher estimated priority fee even with escalation for Mempool"
            );
        }
        _ => panic!("Expected Eip1559 gas price"),
    }
}

#[tokio::test]
async fn test_pending_inclusion_uses_higher_estimated_price_without_escalation() {
    // Test that PendingInclusion uses fresh estimates even when they're higher
    let (adapter, _, _) = setup_mock_provider_with_gas_estimate(100000, 2000);

    let tx_mempool = tx_with_status_and_gas_price(TransactionStatus::Mempool);
    let tx_pending = tx_with_status_and_gas_price(TransactionStatus::PendingInclusion);

    let result_mempool = adapter.estimate_gas_price(&tx_mempool).await.unwrap();
    let result_pending = adapter.estimate_gas_price(&tx_pending).await.unwrap();

    // Both should get high gas prices due to high base_fee
    // But Mempool should still be higher due to escalation
    match (result_mempool, result_pending) {
        (
            GasPrice::Eip1559 {
                max_fee: mempool_max_fee,
                max_priority_fee: mempool_priority,
            },
            GasPrice::Eip1559 {
                max_fee: pending_max_fee,
                max_priority_fee: pending_priority,
            },
        ) => {
            // Both should be high, but mempool should still be higher due to escalation
            assert!(
                pending_max_fee > U256::from(100000),
                "PendingInclusion should use fresh estimate which is high"
            );
            assert!(
                mempool_max_fee > pending_max_fee,
                "Mempool with escalation should be higher than PendingInclusion"
            );
        }
        _ => panic!("Expected Eip1559 gas prices"),
    }
}
