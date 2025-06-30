use core::panic;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::{TransactionReceipt, H160, H256 as EthersH256, U256 as EthersU256};
use ethers::utils::EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE;
use tokio::{select, sync::mpsc};
use tracing_test::traced_test;

use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::{ChainCommunicationError, HyperlaneDomain, KnownHyperlaneDomain, H256, U256};
use hyperlane_ethereum::EthereumReorgPeriod;

use crate::adapter::chains::ethereum::{
    apply_estimate_buffer_to_ethers,
    tests::{dummy_evm_tx, ExpectedTxState, ExpectedTxType, MockEvmProvider},
    EthereumAdapter, EthereumAdapterMetrics, NonceDb, NonceManager, NonceManagerState,
    NonceUpdater, Precursor,
};
use crate::dispatcher::{DispatcherState, InclusionStage, PayloadDb, TransactionDb};
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::Transaction;
use crate::{DispatcherMetrics, FullPayload, PayloadStatus, TransactionStatus};

const TEST_DOMAIN: KnownHyperlaneDomain = KnownHyperlaneDomain::Arbitrum;
static TEST_GAS_LIMIT: LazyLock<EthersU256> = LazyLock::new(|| {
    apply_estimate_buffer_to_ethers(EthersU256::from(21000), &TEST_DOMAIN.into()).unwrap()
});

#[tokio::test]
#[traced_test]
async fn test_inclusion_happy_path() {
    let block_time = Duration::from_millis(20);
    let mock_evm_provider = mocked_evm_provider();

    let expected_tx_states = vec![
        ExpectedTxState {
            nonce: None,
            gas_limit: None,
            gas_price: None,
            priority_fee: None,
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(200000)), // Default fee used by the `ethers` lib estimation logic
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::Mempool,
            retries: 1,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(200000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::Included,
            retries: 1,
            tx_type: ExpectedTxType::Eip1559,
        },
    ];
    run_and_expect_successful_inclusion(
        ExpectedTxType::Eip1559,
        expected_tx_states,
        mock_evm_provider,
        block_time,
    )
    .await;
}

#[tokio::test]
#[traced_test]
async fn test_inclusion_gas_spike() {
    let block_time = Duration::from_millis(20);
    let hash = H256::random(); // Mocked transaction hash

    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_estimate_gas_limit(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);

    // return the mock receipt that has no block for the first 3 submissions, then full receipt for the last one
    let mut tx_receipt_call_counter = 0;
    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| {
            tx_receipt_call_counter += 1;
            if tx_receipt_call_counter < 4 {
                Ok(Some(mock_tx_receipt(None, hash))) // No block number for the first 3 submissions
            } else {
                Ok(Some(mock_tx_receipt(Some(50), hash))) // Block number for the last submission
            }
        });

    let mut fee_history_call_counter = 0;
    mock_evm_provider
        .expect_fee_history()
        .returning(move |_, _, _| {
            fee_history_call_counter += 1;
            let base_fee = match fee_history_call_counter {
                1 => 200000,
                // second submission, price spikes less than 10% spike (to test that we escalate 10% correctly, so the pending mempool tx actually gets replaced)
                2 => 219000,
                // third submission, price spikes less than 10% spike (to test that we escalate 10% correctly, so the pending mempool tx actually gets replaced)
                3 => 220000,
                // fourth submission, price spikes more than 10% spike (to test that the escalation matches the spike)
                _ => 300000, // This will be the price for the last submission
            };
            let prio_fee = if fee_history_call_counter < 4 {
                0 // No priority fee for the first three submissions
            } else {
                10 // Priority fee for the last submission
            };
            Ok(mock_fee_history(base_fee, prio_fee))
        });

    // assert each expected price by mocking the `send` method of the provider
    let mut send_call_counter = 0;
    let elapsed = Instant::now();
    let base_processing_delay = Duration::from_millis(500);
    let inclusion_stage_processing_delay = Duration::from_millis(100);
    let block_time_clone = block_time.clone();
    mock_evm_provider.expect_send().returning(move |tx, _| {
        send_call_counter += 1;
        // assert the timing of resubmissions to make sure they don't happen more than once per block
        assert_gas_prices_and_timings(
            send_call_counter,
            elapsed,
            base_processing_delay,
            inclusion_stage_processing_delay,
            block_time_clone,
            &tx,
            // First submission, price is 200000 - the default fee used by the `ethers` estimation logic
            // Second submission, price is 10% higher, even though the spike was smaller
            // Third submission, price is 10% higher again, even though the spike was smaller
            // Fourth submission, price matches the spike, because it was greater than 10%
            vec![200000, 220000, 242000],
        );
        Ok(hash)
    });

    let expected_tx_states = vec![
        ExpectedTxState {
            nonce: None,
            gas_limit: None,
            gas_price: None,
            priority_fee: None,
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(200000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::Mempool,
            retries: 1,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(220000)), // This is the price that gets included
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10, // 10% increase
            )),
            status: TransactionStatus::Mempool,
            retries: 2,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(242000)), // This is the price that gets included
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 121 / 100, // another 10% increase
            )),
            status: TransactionStatus::Mempool,
            retries: 3,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(242000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 121 / 100,
            )),
            status: TransactionStatus::Included,
            retries: 3,
            tx_type: ExpectedTxType::Eip1559,
        },
    ];
    run_and_expect_successful_inclusion(
        ExpectedTxType::Eip1559,
        expected_tx_states,
        mock_evm_provider,
        block_time,
    )
    .await;
}

#[tokio::test]
#[traced_test]
async fn test_inclusion_gas_underpriced() {
    let block_time = Duration::from_millis(20);
    let hash = H256::random();

    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_estimate_gas_limit(&mut mock_evm_provider);
    mock_default_fee_history(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);

    // after the tx is sent and gets a tx hash, immediately report it in a finalized block
    // to check that we correctly skip past the `Included` status, straight to `Finalized`
    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| Ok(Some(mock_tx_receipt(Some(42), hash))));

    // assert each expected price by mocking the `send` method of the provider
    let mut send_call_counter = 0;
    let elapsed = Instant::now();
    let base_processing_delay = Duration::from_millis(500);
    // assume 1 second more than usual because that's the retry delay when an error occurs
    let inclusion_stage_processing_delay = Duration::from_millis(1100);
    let block_time_clone = block_time.clone();
    mock_evm_provider.expect_send().returning(move |tx, _| {
        send_call_counter += 1;
        // assert the timing of resubmissions to make sure they don't happen more than once per block
        assert_gas_prices_and_timings(
            send_call_counter,
            elapsed,
            base_processing_delay,
            inclusion_stage_processing_delay,
            block_time_clone,
            &tx,
            // First submission, price is 200000 - the default fee used by the `ethers` estimation logic
            // Second submission, price is 10% higher, to due to the underpriced error
            vec![200000, 220000],
        );
        if send_call_counter < 2 {
            Err(ChainCommunicationError::CustomError(
                "replacement transaction underpriced".to_string(),
            ))
        } else {
            // For the second one, we assume it goes through successfully
            Ok(hash)
        }
    });

    let expected_tx_states = vec![
        ExpectedTxState {
            nonce: None,
            gas_limit: None,
            gas_price: None,
            priority_fee: None,
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            // immediately returning an error causes a submission retry, with a 10% increase in gas price
            gas_price: Some(EthersU256::from(220000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10,
            )),
            status: TransactionStatus::Mempool,
            retries: 1,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(220000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10,
            )),
            status: TransactionStatus::Finalized,
            retries: 1,
            tx_type: ExpectedTxType::Eip1559,
        },
    ];
    run_and_expect_successful_inclusion(
        ExpectedTxType::Eip1559,
        expected_tx_states,
        mock_evm_provider,
        block_time,
    )
    .await;
}

#[tokio::test]
#[traced_test]
async fn test_tx_which_fails_simulation_after_submission_is_delivered() {
    let block_time = Duration::from_millis(20);
    let hash = H256::random();

    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_default_fee_history(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);

    // assume the tx stays stuck for the first 3 submissions, and in spite of it failing simulation,
    // we keep resubmitting it until it finally gets included
    let mut tx_receipt_call_counter = 0;
    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| {
            tx_receipt_call_counter += 1;
            if tx_receipt_call_counter < 4 {
                Ok(Some(mock_tx_receipt(None, hash))) // No block number for the first 3 submissions
            } else {
                Ok(Some(mock_tx_receipt(Some(45), hash))) // Block number for the last submission
            }
        });

    let mut simulate_call_counter = 0;
    mock_evm_provider
        .expect_simulate_batch()
        .returning(move |_| {
            simulate_call_counter += 1;
            // simulation passes on the first call, but fails on the second
            if simulate_call_counter < 2 {
                Ok((vec![], vec![]))
            } else {
                Err(ChainCommunicationError::CustomError(
                    "transaction simulation failed".to_string(),
                ))
            }
        });

    let mut estimate_gas_call_counter = 0;
    mock_evm_provider
        .expect_estimate_gas_limit()
        .returning(move |_, _| {
            estimate_gas_call_counter += 1;
            // simulation passes on the first call but fails on the second
            if estimate_gas_call_counter < 2 {
                // estimation passes on the first call but fails on the second
                Ok(21000.into())
            } else {
                Err(ChainCommunicationError::CustomError(
                    "transaction estimation failed".to_string(),
                ))
            }
        });

    // assert sending the tx always works
    mock_evm_provider
        .expect_send()
        .returning(move |_tx, _| Ok(hash));

    let expected_tx_states = vec![
        ExpectedTxState {
            nonce: None,
            gas_limit: None,
            gas_price: None,
            priority_fee: None,
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(200000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::Mempool,
            retries: 1,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(220000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10,
            )),
            status: TransactionStatus::Mempool,
            retries: 2,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(242000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 121 / 100,
            )),
            status: TransactionStatus::Mempool,
            retries: 3,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(242000)), // This is the price that gets included
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 121 / 100,
            )),
            status: TransactionStatus::Included, // Finally, included after 3 failed simulations
            retries: 3, // still 3 retries, because we don't increment it after successful inclusion
            tx_type: ExpectedTxType::Eip1559,
        },
    ];
    run_and_expect_successful_inclusion(
        ExpectedTxType::Eip1559,
        expected_tx_states,
        mock_evm_provider,
        block_time,
    )
    .await;
}

#[tokio::test]
#[traced_test]
async fn test_inclusion_escalate_but_old_hash_finalized() {
    let block_time = Duration::from_millis(20);
    let hash1 = H256::random();
    let hash2 = H256::random();

    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_estimate_gas_limit(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);
    mock_default_fee_history(&mut mock_evm_provider);

    // Simulate receipt: first check returns None, then the old hash (hash1) is included/finalized
    let mut receipt_call_counter = 0;
    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |tx_hash| {
            receipt_call_counter += 1;
            if receipt_call_counter < 2 {
                Ok(None)
            } else if tx_hash == hash1 {
                Ok(Some(mock_tx_receipt(Some(42), hash1)))
            } else {
                Ok(None)
            }
        });

    // Simulate escalation: first send returns hash1, second send returns hash2 (higher gas)
    let mut send_call_counter = 0;
    mock_evm_provider.expect_send().returning(move |_tx, _| {
        send_call_counter += 1;
        if send_call_counter == 1 {
            Ok(hash1)
        } else {
            Ok(hash2)
        }
    });

    let expected_tx_states = vec![
        ExpectedTxState {
            nonce: None,
            gas_limit: None,
            gas_price: None,
            priority_fee: None,
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(200000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::Mempool,
            retries: 1,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(220000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10,
            )),
            status: TransactionStatus::Mempool,
            retries: 2,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(220000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10,
            )),
            status: TransactionStatus::Finalized,
            retries: 2,
            tx_type: ExpectedTxType::Eip1559,
        },
    ];
    run_and_expect_successful_inclusion(
        ExpectedTxType::Eip1559,
        expected_tx_states,
        mock_evm_provider,
        block_time,
    )
    .await;
}

#[tokio::test]
#[traced_test]
async fn test_escalate_gas_and_upgrade_legacy_to_eip1559() {
    let block_time = Duration::from_millis(20);
    let hash = H256::random();

    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_default_fee_history(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);

    // Simulate estimate_gas_limit returning Ok
    mock_evm_provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(21000.into()));

    // Simulate `send` always returning the same hash
    mock_evm_provider
        .expect_send()
        .returning(move |_, _| Ok(hash));

    // Simulate receipt: first check returns None, then included
    let mut receipt_call_counter = 0;
    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| {
            receipt_call_counter += 1;
            if receipt_call_counter < 2 {
                Ok(None)
            } else {
                Ok(Some(mock_tx_receipt(Some(42), hash)))
            }
        });

    // Prepare expected transaction states:
    // 1. Legacy transaction (before escalation)
    // 2. EIP-1559 transaction (after estimation)
    // 3. EIP-1559 transaction (after escalation)
    // 4. EIP-1559 transaction (after finalization)
    let expected_tx_states = vec![
        ExpectedTxState {
            nonce: None,
            gas_limit: None,
            gas_price: Some(EthersU256::from(200000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            tx_type: ExpectedTxType::Legacy,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(200000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::Mempool,
            retries: 1,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(220000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10, // 10% increase
            )),
            status: TransactionStatus::Mempool,
            retries: 2,
            tx_type: ExpectedTxType::Eip1559,
        },
        ExpectedTxState {
            nonce: Some(EthersU256::from(1)),
            gas_limit: Some(TEST_GAS_LIMIT.clone()),
            gas_price: Some(EthersU256::from(220000)),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10, // 10% increase
            )),
            status: TransactionStatus::Finalized,
            retries: 2,
            tx_type: ExpectedTxType::Eip1559,
        },
    ];

    run_and_expect_successful_inclusion(
        ExpectedTxType::Legacy,
        expected_tx_states,
        mock_evm_provider,
        block_time,
    )
    .await;
}

#[tokio::test]
#[traced_test]
async fn test_inclusion_estimate_gas_limit_error_drops_tx_and_payload() {
    let block_time = Duration::from_millis(20);
    let hash = H256::random();

    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_default_fee_history(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);

    // Simulate estimate_gas_limit returning an error
    mock_evm_provider
        .expect_estimate_gas_limit()
        .returning(|_, _| {
            Err(ChainCommunicationError::CustomError(
                "gas estimation failed".to_string(),
            ))
        });

    // Simulate send and receipt (should not be called, but mock anyway)
    mock_evm_provider
        .expect_send()
        .returning(move |_, _| Ok(hash));
    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| Ok(None));

    let signer = H160::random();
    let dispatcher_state =
        mock_dispatcher_state_with_provider(mock_evm_provider, signer, block_time);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_txs = mock_evm_txs(
        1,
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::PendingInclusion,
        signer,
        ExpectedTxType::Eip1559,
    )
    .await;
    let created_tx = created_txs[0].clone();
    let mock_domain = TEST_DOMAIN.into();
    inclusion_stage_pool
        .lock()
        .await
        .insert(created_tx.uuid.clone(), created_tx.clone());

    // Run the inclusion stage step, which should drop the tx and payload due to gas estimation error
    let result = InclusionStage::process_txs_step(
        &inclusion_stage_pool,
        &finality_stage_sender,
        &dispatcher_state,
        mock_domain,
    )
    .await;

    // The result should be Ok, but the tx should be dropped from the pool and DB
    assert!(result.is_ok());

    // The pool should be empty
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

async fn run_and_expect_successful_inclusion(
    initial_tx_type: ExpectedTxType,
    mut expected_tx_states: Vec<ExpectedTxState>,
    mock_evm_provider: MockEvmProvider,
    block_time: Duration,
) {
    let signer = H160::random();
    let dispatcher_state =
        mock_dispatcher_state_with_provider(mock_evm_provider, signer, block_time);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage_pool = Arc::new(tokio::sync::Mutex::new(HashMap::new()));

    let created_txs = mock_evm_txs(
        1,
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::PendingInclusion,
        signer,
        initial_tx_type,
    )
    .await;
    let created_tx = created_txs[0].clone();
    let mock_domain = TEST_DOMAIN.into();
    inclusion_stage_pool
        .lock()
        .await
        .insert(created_tx.uuid.clone(), created_tx.clone());

    let expected_tx_state = expected_tx_states.remove(0);
    assert_tx_db_state(&expected_tx_state, &dispatcher_state.tx_db, &created_tx).await;

    for expected_tx_state in expected_tx_states.iter() {
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
    // the `select!` macro interferes with the lints, so need to manually `allow`` here
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

async fn assert_tx_db_state(
    expected: &ExpectedTxState,
    tx_db: &Arc<dyn TransactionDb>,
    created_tx: &Transaction,
) {
    let retrieved_tx = tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();
    let evm_tx = &retrieved_tx.precursor().tx;

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

    // Check the transaction type
    let actual_type = match evm_tx {
        TypedTransaction::Legacy(_) => ExpectedTxType::Legacy,
        TypedTransaction::Eip2930(_) => ExpectedTxType::Eip2930,
        TypedTransaction::Eip1559(_) => ExpectedTxType::Eip1559,
    };
    assert_eq!(
        actual_type, expected.tx_type,
        "Transaction type mismatch: expected {:?}, got {:?}",
        expected.tx_type, actual_type
    );
    match expected.nonce {
        Some(ref expected_nonce) => {
            assert_eq!(evm_tx.nonce(), Some(expected_nonce), "Nonce mismatch");
        }
        None => {
            assert!(evm_tx.nonce().is_none(), "Expected nonce to be None");
        }
    }
    match expected.gas_limit {
        Some(ref expected_gas_limit) => {
            assert_eq!(evm_tx.gas(), Some(expected_gas_limit), "Gas limit mismatch");
        }
        None => {
            assert!(evm_tx.gas().is_none(), "Expected gas limit to be None");
        }
    }
    if let TypedTransaction::Eip1559(eip1559_tx) = evm_tx {
        assert_eq!(
            eip1559_tx.max_priority_fee_per_gas, expected.priority_fee,
            "Priority fee mismatch"
        );
        assert_eq!(
            eip1559_tx.max_fee_per_gas,
            expected.gas_price.map(|v| v.into()),
            "Max fee per gas mismatch"
        );
    }
}

fn mocked_evm_provider() -> MockEvmProvider {
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_estimate_gas_limit(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);

    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| {
            Ok(Some(TransactionReceipt {
                transaction_hash: H256::random().into(),
                block_number: Some(444.into()),
                ..Default::default()
            }))
        });
    mock_evm_provider.expect_send().returning(|_, _| {
        Ok(H256::random()) // Mocked transaction hash
    });
    mock_evm_provider
        .expect_fee_history()
        .returning(|_, _, _| Ok(mock_fee_history(0, 0)));

    mock_evm_provider
}

async fn mock_evm_txs(
    num: usize,
    payload_db: &Arc<dyn PayloadDb>,
    tx_db: &Arc<dyn TransactionDb>,
    status: TransactionStatus,
    signer: H160,
    tx_type: ExpectedTxType,
) -> Vec<Transaction> {
    let mut txs = Vec::new();
    for _ in 0..num {
        let mut payload = FullPayload::random();
        payload.status = PayloadStatus::InTransaction(status.clone());
        payload_db.store_payload_by_uuid(&payload).await.unwrap();
        let tx = dummy_evm_tx(tx_type, vec![payload], status.clone(), signer.clone());
        tx_db.store_transaction_by_uuid(&tx).await.unwrap();
        txs.push(tx);
    }
    txs
}

pub fn mock_dispatcher_state_with_provider(
    provider: MockEvmProvider,
    signer: H160,
    block_time: Duration,
) -> DispatcherState {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db.clone(),
        tx_db.clone(),
        nonce_db,
        signer,
        block_time,
    );
    DispatcherState::new(
        payload_db,
        tx_db,
        Arc::new(adapter),
        DispatcherMetrics::dummy_instance(),
        "test".to_string(),
    )
}

fn mock_ethereum_adapter(
    provider: MockEvmProvider,
    payload_db: Arc<dyn PayloadDb>,
    tx_db: Arc<dyn TransactionDb>,
    nonce_db: Arc<dyn NonceDb>,
    signer: H160,
    block_time: Duration,
) -> EthereumAdapter {
    let domain: HyperlaneDomain = TEST_DOMAIN.into();
    let provider = Arc::new(provider);
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let metrics = EthereumAdapterMetrics::dummy_instance();
    let state = Arc::new(NonceManagerState::new(nonce_db, tx_db, signer, metrics));

    let nonce_updater = NonceUpdater::new(
        signer,
        reorg_period,
        block_time,
        provider.clone(),
        state.clone(),
    );

    let nonce_manager = NonceManager {
        address: signer,
        state,
        nonce_updater,
    };

    let op_submission_config = OpSubmissionConfig::default();
    let batch_contract_address = op_submission_config
        .batch_contract_address
        .unwrap_or_default();

    EthereumAdapter {
        estimated_block_time: block_time,
        domain,
        transaction_overrides: Default::default(),
        submission_config: op_submission_config,
        provider,
        reorg_period,
        nonce_manager,
        batch_cache: Default::default(),
        batch_contract_address,
        payload_db,
        signer,
    }
}

fn mock_fee_history(base_fee: u32, prio_fee: u32) -> ethers::types::FeeHistory {
    ethers::types::FeeHistory {
        oldest_block: 0.into(),
        reward: vec![vec![prio_fee.into()]],
        base_fee_per_gas: vec![base_fee.into()],
        gas_used_ratio: vec![0.0],
    }
}

fn mock_tx_receipt(block_number: Option<u64>, hash: H256) -> TransactionReceipt {
    TransactionReceipt {
        transaction_hash: hash.into(),
        block_number: block_number.map(|n| n.into()),
        ..Default::default()
    }
}

fn mock_block(block_number: u64, base_fee: u32) -> ethers::types::Block<EthersH256> {
    ethers::types::Block {
        number: Some(block_number.into()),
        base_fee_per_gas: Some(base_fee.into()),
        gas_limit: 30000000.into(),
        ..Default::default()
    }
}

fn mock_default_fee_history(mock_evm_provider: &mut MockEvmProvider) {
    mock_evm_provider
        .expect_fee_history()
        .returning(move |_, _, _| Ok(mock_fee_history(200000, 10)));
}

fn mock_finalized_block_number(mock_evm_provider: &mut MockEvmProvider) {
    mock_evm_provider
        .expect_get_finalized_block_number()
        .returning(|_reorg_period| Ok(43)); // Mocked block number
}

fn mock_estimate_gas_limit(mock_evm_provider: &mut MockEvmProvider) {
    mock_evm_provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(21000.into())); // Mocked gas limit
}

fn mock_get_block(mock_evm_provider: &mut MockEvmProvider) {
    mock_evm_provider
        .expect_get_block()
        .returning(|_| Ok(Some(mock_block(42, 100)))); // Mocked block retrieval
}

fn mock_get_next_nonce_on_finalized_block(mock_evm_provider: &mut MockEvmProvider) {
    mock_evm_provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(move |_, _| Ok(U256::one()));
}

fn assert_gas_prices_and_timings(
    nth_submission: usize,
    start_time: Instant,
    base_processing_delay: Duration,
    inclusion_stage_processing_delay: Duration,
    block_time: Duration,
    tx: &TypedTransaction,
    gas_price_expectations: Vec<u32>,
) {
    let actual_elapsed = start_time.elapsed();
    let expected_elapsed = base_processing_delay
        + (inclusion_stage_processing_delay + block_time) * (nth_submission as u32);
    assert!(
        actual_elapsed < expected_elapsed,
        "(submission {}) elapsed {:?} was not < expected {:?}",
        nth_submission,
        actual_elapsed,
        expected_elapsed
    );
    assert_eq!(
        tx.gas_price().unwrap(),
        gas_price_expectations[nth_submission - 1].into(),
        "gas price for submission {} doesn't match expected value",
        nth_submission
    );
}
