#![allow(deprecated)]

use core::panic;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use ethers::abi::{Function, Param, ParamType, StateMutability};
use ethers::types::{
    transaction::eip2718::TypedTransaction, Eip1559TransactionRequest, TransactionReceipt, H160,
    H256 as EthersH256, U256 as EthersU256,
};
use ethers::utils::EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE;
use tokio::{select, sync::mpsc};
use tracing_test::traced_test;

use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::identifiers::UniqueIdentifier;
use hyperlane_core::{ChainCommunicationError, HyperlaneDomain, KnownHyperlaneDomain, H256, U256};
use hyperlane_ethereum::EthereumReorgPeriod;

use crate::adapter::chains::ethereum::{
    apply_estimate_buffer_to_ethers,
    nonce::{db::NonceDb, NonceManager, NonceManagerState, NonceUpdater},
    tests::MockEvmProvider,
    EthereumAdapter, EthereumAdapterMetrics, EthereumTxPrecursor, Precursor,
};
use crate::dispatcher::{DispatcherState, InclusionStage, PayloadDb, TransactionDb};
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::{Transaction, VmSpecificTxData};
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
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(200000), // Default fee used by the ethers estimation logic
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::Mempool,
            retries: 1,
        },
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(200000),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::Included,
            retries: 1,
        },
    ];
    run_and_expect_successful_inclusion(expected_tx_states, mock_evm_provider, block_time).await;
}

#[tokio::test]
#[traced_test]
async fn test_inclusion_gas_spike() {
    let block_time = Duration::from_millis(20);
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_estimate_gas_limit(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);

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

    // return mock receipt that has no block for first 3 submissions, then full receipt for the last one
    let mut tx_receipt_call_counter = 0;
    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| {
            tx_receipt_call_counter += 1;
            if tx_receipt_call_counter < 4 {
                Ok(Some(mock_tx_receipt(None))) // No block number for first 3 submissions
            } else {
                Ok(Some(mock_tx_receipt(Some(50)))) // Block number for the last submission
            }
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
            // First submission, price is 200000 - the default fee used by the ethers estimation logic
            // Second submission, price is 10% higher, even though the spike was smaller
            // Third submission, price is 10% higher again, even though the spike was smaller
            // Fourth submission, price matches the spike, because it was greater than 10%
            vec![200000, 220000, 242000],
        );
        Ok(H256::random()) // Mocked transaction hash
    });

    let expected_tx_states = vec![
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(200000),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::Mempool,
            retries: 1,
        },
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(220000), // This is the price that gets included
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10, // 10% increase
            )),
            status: TransactionStatus::Mempool,
            retries: 2,
        },
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(242000), // This is the price that gets included
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 121 / 100, // another 10% increase
            )),
            status: TransactionStatus::Mempool,
            retries: 3,
        },
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(242000),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 121 / 100,
            )),
            status: TransactionStatus::Included,
            retries: 3,
        },
    ];
    run_and_expect_successful_inclusion(expected_tx_states, mock_evm_provider, block_time).await;
}

#[tokio::test]
#[traced_test]
async fn test_inclusion_gas_underpriced() {
    let block_time = Duration::from_millis(20);
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
        .returning(move |_| Ok(Some(mock_tx_receipt(Some(42)))));

    mock_evm_provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::one()));

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
            // First submission, price is 200000 - the default fee used by the ethers estimation logic
            // Second submission, price is 10% higher, to due to the underpriced error
            vec![200000, 220000],
        );
        if send_call_counter < 2 {
            Err(ChainCommunicationError::CustomError(
                "replacement transaction underpriced".to_string(),
            ))
        } else {
            // For the second one, we assume it goes through successfully
            Ok(H256::random())
        }
    });

    let expected_tx_states = vec![
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            // immediately returning an error causes a submission retry, with a 10% increase in gas price
            gas_price: EthersU256::from(220000),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10,
            )),
            status: TransactionStatus::Mempool,
            retries: 1,
        },
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(220000),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10,
            )),
            status: TransactionStatus::Finalized,
            retries: 1,
        },
    ];
    run_and_expect_successful_inclusion(expected_tx_states, mock_evm_provider, block_time).await;
}

#[tokio::test]
#[traced_test]
async fn test_tx_which_fails_simulation_after_submission_is_delivered() {
    let block_time = Duration::from_millis(20);
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_default_fee_history(&mut mock_evm_provider);
    mock_get_next_nonce_on_finalized_block(&mut mock_evm_provider);
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
            // simulation passes on the first call, but fails on the second
            if estimate_gas_call_counter < 2 {
                // estimation passes on the first call, but fails on the second
                Ok(21000.into())
            } else {
                Err(ChainCommunicationError::CustomError(
                    "transaction estimation failed".to_string(),
                ))
            }
        });

    // assume the tx stays stuck for the first 3 submissions, and in spite of it failing simulation,
    // we keep resubmitting it until it finally gets included
    let mut tx_receipt_call_counter = 0;
    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| {
            tx_receipt_call_counter += 1;
            if tx_receipt_call_counter < 4 {
                Ok(Some(mock_tx_receipt(None))) // No block number for first 3 submissions
            } else {
                Ok(Some(mock_tx_receipt(Some(45)))) // Block number for the last submission
            }
        });

    // assert sending the tx always works
    mock_evm_provider
        .expect_send()
        .returning(move |_tx, _| Ok(H256::random()));

    let expected_tx_states = vec![
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(200000),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE,
            )),
            status: TransactionStatus::Mempool,
            retries: 1,
        },
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(220000),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 11 / 10,
            )),
            status: TransactionStatus::Mempool,
            retries: 2,
        },
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(242000),
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 121 / 100,
            )),
            status: TransactionStatus::Mempool,
            retries: 3,
        },
        ExpectedTxState {
            nonce: EthersU256::from(1),
            gas_limit: TEST_GAS_LIMIT.clone(),
            gas_price: EthersU256::from(242000), // This is the price that gets included
            priority_fee: Some(EthersU256::from(
                EIP1559_FEE_ESTIMATION_DEFAULT_PRIORITY_FEE * 121 / 100,
            )),
            status: TransactionStatus::Included, // Finally included after 3 failed simulations
            retries: 3, // still 3 retries, because we don't increment it after successful inclusion
        },
    ];
    run_and_expect_successful_inclusion(expected_tx_states, mock_evm_provider, block_time).await;
}

struct ExpectedTxState {
    nonce: EthersU256,
    gas_limit: EthersU256,
    // either gas price or max fee per gas
    gas_price: EthersU256,
    priority_fee: Option<EthersU256>,
    status: TransactionStatus,
    retries: u32,
}

/// Arguments that need explaining:
/// `expected_tx_states` - for each expected iteration of the inclusion stage, we expect the DB to reflect a tx with the following properties
/// arguments
async fn run_and_expect_successful_inclusion(
    expected_tx_states: Vec<ExpectedTxState>,
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
    )
    .await;
    let created_tx = created_txs[0].clone();
    let mock_domain = TEST_DOMAIN.into();
    inclusion_stage_pool
        .lock()
        .await
        .insert(created_tx.uuid.clone(), created_tx.clone());

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

    assert_eq!(evm_tx.nonce(), Some(&expected.nonce), "Nonce mismatch");
    assert_eq!(
        evm_tx.gas(),
        Some(&expected.gas_limit),
        "Gas limit mismatch"
    );
    if let TypedTransaction::Eip1559(eip1559_tx) = evm_tx {
        assert_eq!(
            eip1559_tx.max_priority_fee_per_gas, expected.priority_fee,
            "Priority fee mismatch"
        );
        assert_eq!(
            eip1559_tx.max_fee_per_gas,
            Some(expected.gas_price.into()),
            "Max fee per gas mismatch"
        );
    }
}

fn mocked_evm_provider() -> MockEvmProvider {
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_estimate_gas_limit(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);

    mock_evm_provider.expect_send().returning(|_, _| {
        Ok(H256::random()) // Mocked transaction hash
    });
    mock_evm_provider
        .expect_fee_history()
        .returning(|_, _, _| Ok(mock_fee_history(0, 0)));
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

    mock_evm_provider
}

pub(crate) async fn mock_evm_txs(
    num: usize,
    payload_db: &Arc<dyn PayloadDb>,
    tx_db: &Arc<dyn TransactionDb>,
    status: TransactionStatus,
    signer: H160,
) -> Vec<Transaction> {
    let mut txs = Vec::new();
    for _ in 0..num {
        let mut payload = FullPayload::random();
        payload.status = PayloadStatus::InTransaction(status.clone());
        payload_db.store_payload_by_uuid(&payload).await.unwrap();
        let tx = dummy_evm_tx(vec![payload], status.clone(), signer.clone());
        tx_db.store_transaction_by_uuid(&tx).await.unwrap();
        txs.push(tx);
    }
    txs
}

pub fn dummy_evm_tx(
    payloads: Vec<FullPayload>,
    status: TransactionStatus,
    signer: H160,
) -> Transaction {
    let details: Vec<_> = payloads
        .clone()
        .into_iter()
        .map(|payload| payload.details)
        .collect();
    Transaction {
        uuid: UniqueIdentifier::random(),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Evm(dummy_tx_precursor(signer)),
        payload_details: details.clone(),
        status,
        submission_attempts: 0,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
    }
}

pub fn dummy_tx_precursor(signer: H160) -> EthereumTxPrecursor {
    let function = Function {
        name: "baz".to_owned(),
        inputs: vec![
            Param {
                name: "a".to_owned(),
                kind: ParamType::Uint(32),
                internal_type: None,
            },
            Param {
                name: "b".to_owned(),
                kind: ParamType::Bool,
                internal_type: None,
            },
        ],
        outputs: vec![],
        constant: None,
        state_mutability: StateMutability::Payable,
    };
    EthereumTxPrecursor {
        tx: TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(signer),
            to: Some(ethers::types::NameOrAddress::Address(H160::random())), // Random recipient address
            gas: None,
            value: None,
            data: None,
            nonce: None,
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            chain_id: None,
            ..Default::default()
        }),
        function,
    }
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

fn mock_tx_receipt(block_number: Option<u64>) -> TransactionReceipt {
    TransactionReceipt {
        transaction_hash: H256::random().into(),
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
        .returning(move |_, _| Ok(1.into()));
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
