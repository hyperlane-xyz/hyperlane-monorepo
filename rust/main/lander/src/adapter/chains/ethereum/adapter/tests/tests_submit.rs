use std::sync::Arc;
use std::time::Duration;

use ethers::abi::{Function, StateMutability};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::transaction::eip2930::AccessList;
use ethers::types::{Address, Eip1559TransactionRequest, NameOrAddress, U256 as EthersU256, U64};
use hyperlane_core::{H256, U256};

use crate::adapter::chains::ethereum::tests::MockEvmProvider;
use crate::adapter::chains::ethereum::transaction::Precursor;
use crate::adapter::{AdaptsChain, AdaptsChainAction};
use crate::tests::evm::test_utils::mock_ethereum_adapter;
use crate::tests::test_utils::tmp_dbs;
use crate::{FullPayload, TransactionUuid};

fn build_mock_typed_tx_and_function() -> (TypedTransaction, Function) {
    let typed_tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
        from: Some(Address::random()),
        to: Some(NameOrAddress::Address(Address::random())),
        gas: Some(EthersU256::from(21000)),
        value: None,
        data: None,
        nonce: None, // Start with no nonce
        access_list: AccessList::default(),
        max_fee_per_gas: Some(EthersU256::from(1000)),
        max_priority_fee_per_gas: Some(EthersU256::from(1000)),
        chain_id: Some(U64::from(1)),
    });

    #[allow(deprecated)]
    let function = Function {
        name: "test_function".into(),
        inputs: Vec::new(),
        outputs: Vec::new(),
        constant: None,
        state_mutability: StateMutability::Pure,
    };

    (typed_tx, function)
}

/// Test that adapter.submit assigns a nonce to a transaction
#[tokio::test]
async fn test_submit_assigns_nonce() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let mut provider = MockEvmProvider::new();

    provider
        .expect_get_finalized_block_number()
        .returning(|_| Ok(43));

    // Provider returns next nonce = 51, so finalized will be 50
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(hyperlane_core::U256::from(51)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(ethers::types::Block {
            number: Some(42.into()),
            base_fee_per_gas: Some(100.into()),
            gas_limit: 30000000.into(),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![200000.into()],
            gas_used_ratio: vec![0.0],
        })
    });

    provider.expect_send().returning(|_, _| Ok(H256::random()));

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);

    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db.clone(),
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    // Build a transaction
    let data = build_mock_typed_tx_and_function();
    let json_data = serde_json::to_vec(&data).expect("Failed to serialize data");

    let mut payload = FullPayload::random();
    payload.data = json_data;
    payload_db.store_payload_by_uuid(&payload).await.unwrap();

    let tx_results = adapter.build_transactions(&[payload]).await;
    assert_eq!(tx_results.len(), 1);

    let mut tx = tx_results[0].maybe_tx.clone().unwrap();

    // Verify transaction has no nonce initially
    assert!(
        tx.precursor().tx.nonce().is_none(),
        "Transaction should not have a nonce before submit"
    );

    // Submit the transaction - this will call update_boundaries which sets finalized=50, upper=51
    adapter
        .submit(&mut tx)
        .await
        .expect("Failed to submit transaction");

    // Verify the transaction was assigned a nonce
    let assigned_nonce = tx
        .precursor()
        .tx
        .nonce()
        .expect("Transaction should have a nonce after submit");
    assert_eq!(
        *assigned_nonce,
        EthersU256::from(51),
        "Transaction should be assigned nonce 51 (first available nonce)"
    );
}

/// Test that after run_command resets the nonce, submit assigns the correct new nonce
#[tokio::test]
async fn test_submit_assigns_correct_nonce_after_reset() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let mut provider = MockEvmProvider::new();

    provider
        .expect_get_finalized_block_number()
        .returning(|_| Ok(43));

    // Provider returns next nonce = 91, so finalized will be 90
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(hyperlane_core::U256::from(91)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(ethers::types::Block {
            number: Some(42.into()),
            base_fee_per_gas: Some(100.into()),
            gas_limit: 30000000.into(),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![200000.into()],
            gas_used_ratio: vec![0.0],
        })
    });

    provider.expect_send().returning(|_, _| Ok(H256::random()));

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);

    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db.clone(),
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    // Set up initial state: finalized = 90, upper = 150
    // This simulates a situation where we have many pending transactions
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce_test(&hyperlane_core::U256::from(90))
        .await
        .unwrap();
    adapter
        .nonce_manager
        .state
        .set_upper_nonce_test(&hyperlane_core::U256::from(150))
        .await
        .unwrap();

    // Build and submit a transaction
    let data = build_mock_typed_tx_and_function();
    let json_data = serde_json::to_vec(&data).expect("Failed to serialize data");

    let mut payload = FullPayload::random();
    payload.data = json_data;
    payload_db.store_payload_by_uuid(&payload).await.unwrap();

    let tx_results = adapter.build_transactions(&[payload]).await;
    assert_eq!(tx_results.len(), 1);

    let mut tx = tx_results[0].maybe_tx.clone().unwrap();

    // Make sure all the nonces are in use.
    for i in 90..150 {
        let tx_nonce = U256::from(i);
        let tx_uuid = TransactionUuid::random();
        adapter
            .nonce_manager
            .state
            .set_tracked_tx_uuid_test(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
        let mut tx_clone = tx.clone();
        tx_clone.uuid = tx_uuid;
        tx_db.store_transaction_by_uuid(&tx_clone).await.unwrap();
    }

    // Submit the transaction - update_boundaries will set finalized=90, but upper stays at 100
    // because finalized (90) < upper (100)
    adapter
        .submit(&mut tx)
        .await
        .expect("Failed to submit transaction");

    // Verify the transaction was assigned nonce 101 (upper nonce + 1)
    // This demonstrates that run_command successfully reset the nonce
    let assigned_nonce = tx
        .precursor()
        .tx
        .nonce()
        .expect("Transaction should have a nonce");
    assert_eq!(
        *assigned_nonce,
        EthersU256::from(150),
        "New transaction should be assigned nonce 150 (upper nonce)"
    );

    // Reset upper nonce to 100 using run_command
    adapter
        .run_command(AdaptsChainAction::SetUpperNonce { nonce: Some(100) })
        .await
        .expect("Failed to reset nonce");

    // Submit the transaction - update_boundaries will set finalized=90, but upper stays at 100
    // because finalized (90) < upper (100)
    adapter
        .submit(&mut tx)
        .await
        .expect("Failed to submit transaction");

    // Verify the transaction was assigned nonce 101 (upper nonce + 1)
    // This demonstrates that run_command successfully reset the nonce
    let assigned_nonce = tx
        .precursor()
        .tx
        .nonce()
        .expect("Transaction should have a nonce");
    assert_eq!(
        *assigned_nonce,
        EthersU256::from(100),
        "New transaction should be assigned nonce 101 (upper after reset + 1)"
    );

    // Verify the upper nonce was incremented to 101
    let new_upper_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce_test()
        .await
        .unwrap();
    assert_eq!(
        new_upper_nonce,
        hyperlane_core::U256::from(101),
        "Upper nonce should be incremented to 101 after transaction submission"
    );
}

/// Test that multiple submissions after reset increment nonces correctly
#[tokio::test]
async fn test_multiple_submissions_after_reset() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let mut provider = MockEvmProvider::new();

    provider
        .expect_get_finalized_block_number()
        .returning(|_| Ok(43));

    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(hyperlane_core::U256::from(100)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(ethers::types::Block {
            number: Some(42.into()),
            base_fee_per_gas: Some(100.into()),
            gas_limit: 30000000.into(),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![200000.into()],
            gas_used_ratio: vec![0.0],
        })
    });

    provider.expect_send().returning(|_, _| Ok(H256::random()));

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);

    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db.clone(),
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    // Set up initial state: finalized = 90, upper = 150
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce_test(&hyperlane_core::U256::from(100))
        .await
        .unwrap();
    adapter
        .nonce_manager
        .state
        .set_upper_nonce_test(&hyperlane_core::U256::from(150))
        .await
        .unwrap();

    // Reset upper nonce to 100 using run_command
    adapter
        .run_command(AdaptsChainAction::SetUpperNonce { nonce: Some(101) })
        .await
        .expect("Failed to reset nonce");

    let tx1 = build_and_store_transaction(&adapter, &payload_db).await;
    // Make sure all the nonces are in use.
    for i in 100..101 {
        let tx_nonce = U256::from(i);
        let tx_uuid = TransactionUuid::random();
        adapter
            .nonce_manager
            .state
            .set_tracked_tx_uuid_test(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
        let mut tx_clone = tx1.clone();
        tx_clone.uuid = tx_uuid;
        tx_db.store_transaction_by_uuid(&tx_clone).await.unwrap();
    }

    // Submit three transactions and verify nonce increments
    // First submit will call update_boundaries (setting finalized=99, upper=100)
    // Subsequent submits happen too quickly to trigger another update_boundaries
    let expected_nonces = vec![101, 102, 103];

    for expected_nonce in expected_nonces {
        let data = build_mock_typed_tx_and_function();
        let json_data = serde_json::to_vec(&data).expect("Failed to serialize data");

        let mut payload = FullPayload::random();
        payload.data = json_data;
        payload_db.store_payload_by_uuid(&payload).await.unwrap();

        let tx_results = adapter.build_transactions(&[payload]).await;
        assert_eq!(tx_results.len(), 1);

        let mut tx = tx_results[0].maybe_tx.clone().unwrap();
        tx_db.store_transaction_by_uuid(&tx).await.unwrap();

        // Submit the transaction
        adapter
            .submit(&mut tx)
            .await
            .expect("Failed to submit transaction");

        // Verify the nonce
        let assigned_nonce = tx
            .precursor()
            .tx
            .nonce()
            .expect("Transaction should have a nonce");
        assert_eq!(
            *assigned_nonce,
            EthersU256::from(expected_nonce),
            "Transaction should be assigned nonce {}",
            expected_nonce
        );
    }

    // Verify the final upper nonce
    let final_upper_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce_test()
        .await
        .unwrap();
    assert_eq!(
        final_upper_nonce,
        hyperlane_core::U256::from(104),
        "Upper nonce should be 104 after three submissions"
    );
}

/// Test that submit handles nonce reset to finalized + 1
#[tokio::test]
async fn test_submit_after_reset_to_finalized_plus_one() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let mut provider = MockEvmProvider::new();

    provider
        .expect_get_finalized_block_number()
        .returning(|_| Ok(43));

    // Provider returns next nonce = 76, so finalized will be 75
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(hyperlane_core::U256::from(76)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(ethers::types::Block {
            number: Some(42.into()),
            base_fee_per_gas: Some(100.into()),
            gas_limit: 30000000.into(),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![200000.into()],
            gas_used_ratio: vec![0.0],
        })
    });

    provider.expect_send().returning(|_, _| Ok(H256::random()));

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);

    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db.clone(),
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    // Set up initial state: finalized = 75, upper = 200
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce_test(&hyperlane_core::U256::from(75))
        .await
        .unwrap();
    adapter
        .nonce_manager
        .state
        .set_upper_nonce_test(&hyperlane_core::U256::from(200))
        .await
        .unwrap();

    // Reset upper nonce to None (finalized + 1 = 76)
    adapter
        .run_command(AdaptsChainAction::SetUpperNonce { nonce: None })
        .await
        .expect("Failed to reset nonce to finalized + 1");

    // Build and submit a transaction
    let data = build_mock_typed_tx_and_function();
    let json_data = serde_json::to_vec(&data).expect("Failed to serialize data");

    let mut payload = FullPayload::random();
    payload.data = json_data;
    payload_db.store_payload_by_uuid(&payload).await.unwrap();

    let tx_results = adapter.build_transactions(&[payload]).await;
    assert_eq!(tx_results.len(), 1);

    let mut tx = tx_results[0].maybe_tx.clone().unwrap();

    // Submit the transaction - update_boundaries sets finalized=75, upper stays at 76 (from run_command)
    adapter
        .submit(&mut tx)
        .await
        .expect("Failed to submit transaction");

    // Verify the transaction was assigned nonce 76 (upper)
    let assigned_nonce = tx
        .precursor()
        .tx
        .nonce()
        .expect("Transaction should have a nonce");
    assert_eq!(
        *assigned_nonce,
        EthersU256::from(76),
        "Transaction should be assigned nonce 76 (upper after reset to finalized+1, then incremented)"
    );

    // Verify the upper nonce
    let new_upper_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce_test()
        .await
        .unwrap();
    assert_eq!(
        new_upper_nonce,
        hyperlane_core::U256::from(77),
        "Upper nonce should be 77 after submission"
    );
}

/// Test that submit correctly handles interleaved resets and submissions
#[tokio::test]
async fn test_submit_with_interleaved_resets() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let mut provider = MockEvmProvider::new();

    provider
        .expect_get_finalized_block_number()
        .returning(|_| Ok(43));

    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(hyperlane_core::U256::from(51)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(ethers::types::Block {
            number: Some(42.into()),
            base_fee_per_gas: Some(100.into()),
            gas_limit: 30000000.into(),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![200000.into()],
            gas_used_ratio: vec![0.0],
        })
    });

    provider.expect_send().returning(|_, _| Ok(H256::random()));

    let signer = Address::random();
    let block_time = Duration::from_millis(100);
    let minimum_time_between_resubmissions = Duration::from_millis(100);

    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db.clone(),
        signer,
        block_time,
        minimum_time_between_resubmissions,
    );

    // Set up initial state: finalized = 50, upper = 100
    adapter
        .nonce_manager
        .state
        .set_finalized_nonce_test(&hyperlane_core::U256::from(50))
        .await
        .unwrap();
    adapter
        .nonce_manager
        .state
        .set_upper_nonce_test(&hyperlane_core::U256::from(100))
        .await
        .unwrap();

    // First submission - update_boundaries sets finalized=50, upper stays at 100
    // Next nonce will be 101
    let mut tx1 = build_and_store_transaction(&adapter, &payload_db).await;

    // Make sure all the nonces are in use.
    for i in 50..100 {
        let tx_nonce = U256::from(i);
        let tx_uuid = TransactionUuid::random();
        adapter
            .nonce_manager
            .state
            .set_tracked_tx_uuid_test(&tx_nonce, &tx_uuid)
            .await
            .expect("Failed to store nonce and transaction uuid");
        let mut tx_clone = tx1.clone();
        tx_clone.uuid = tx_uuid;
        tx_db.store_transaction_by_uuid(&tx_clone).await.unwrap();
    }

    adapter
        .submit(&mut tx1)
        .await
        .expect("Failed to submit transaction 1");
    assert_eq!(
        *tx1.precursor().tx.nonce().unwrap(),
        EthersU256::from(100),
        "First transaction should have nonce 100"
    );

    // Reset to 80 - effectively rolling back the nonce
    adapter
        .run_command(AdaptsChainAction::SetUpperNonce { nonce: Some(80) })
        .await
        .expect("Failed to reset nonce to 80");

    // Second submission - upper is now 80
    let mut tx2 = build_and_store_transaction(&adapter, &payload_db).await;
    tx_db.store_transaction_by_uuid(&tx2).await.unwrap();
    adapter
        .submit(&mut tx2)
        .await
        .expect("Failed to submit transaction 2");
    assert_eq!(
        *tx2.precursor().tx.nonce().unwrap(),
        EthersU256::from(80),
        "Second transaction should have nonce 80 after reset"
    );

    // Third submission - upper is now 81, so next nonce is 82
    let mut tx3 = build_and_store_transaction(&adapter, &payload_db).await;
    adapter
        .submit(&mut tx3)
        .await
        .expect("Failed to submit transaction 3");
    tx_db.store_transaction_by_uuid(&tx3).await.unwrap();
    assert_eq!(
        *tx3.precursor().tx.nonce().unwrap(),
        EthersU256::from(81),
        "Third transaction should have nonce 81"
    );

    // Final upper nonce should be 82
    let final_upper_nonce = adapter
        .nonce_manager
        .state
        .get_upper_nonce_test()
        .await
        .unwrap();
    assert_eq!(
        final_upper_nonce,
        hyperlane_core::U256::from(82),
        "Final upper nonce should be 81"
    );
}

// Helper function to build and store a transaction
async fn build_and_store_transaction(
    adapter: &crate::adapter::chains::ethereum::EthereumAdapter,
    payload_db: &Arc<dyn crate::dispatcher::PayloadDb>,
) -> crate::transaction::Transaction {
    let data = build_mock_typed_tx_and_function();
    let json_data = serde_json::to_vec(&data).expect("Failed to serialize data");

    let mut payload = FullPayload::random();
    payload.data = json_data;
    payload_db.store_payload_by_uuid(&payload).await.unwrap();

    let tx_results = adapter.build_transactions(&[payload]).await;
    assert_eq!(tx_results.len(), 1);

    tx_results[0].maybe_tx.clone().unwrap()
}
