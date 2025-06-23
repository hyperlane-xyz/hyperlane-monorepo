#![allow(deprecated)]

use core::panic;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use ethers::{
    abi::{Function, Param, ParamType, StateMutability},
    types::{
        transaction::eip2718::TypedTransaction, Eip1559TransactionRequest, TransactionReceipt,
        H160, H256 as EthersH256,
    },
};
use tokio::{
    select,
    sync::{mpsc, Mutex},
};
use tracing_test::traced_test;

use hyperlane_core::{
    config::OpSubmissionConfig, identifiers::UniqueIdentifier, ChainCommunicationError,
    HyperlaneDomain, KnownHyperlaneDomain, H256, U256,
};
use hyperlane_ethereum::EthereumReorgPeriod;

use crate::adapter::chains::ethereum::{transaction::Precursor, EthereumAdapterMetrics};
use crate::tests::test_utils::tmp_dbs;
use crate::{
    adapter::{
        chains::ethereum::{
            nonce::{db::NonceDb, NonceManager, NonceManagerState, NonceUpdater},
            tests::MockEvmProvider,
            EthereumAdapter,
        },
        EthereumTxPrecursor,
    },
    dispatcher::{DispatcherState, InclusionStage, PayloadDb, TransactionDb},
    transaction::{Transaction, VmSpecificTxData},
    DispatcherMetrics, FullPayload, PayloadStatus, TransactionStatus,
};

#[tokio::test]
#[traced_test]
async fn test_inclusion_happy_path() {
    let block_time = Duration::from_millis(20);
    let mock_evm_provider = mocked_evm_provider();

    run_and_expect_successful_inclusion(mock_evm_provider, block_time).await;
}

#[tokio::test]
#[traced_test]
async fn test_inclusion_gas_spike() {
    let block_time = Duration::from_millis(20);
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_estimate_gas_limit(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);

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
                Ok(Some(mock_tx_receipt(Some(42)))) // Block number for the last submission
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
            vec![200000, 220000, 242000, 300000],
        );
        Ok(H256::random()) // Mocked transaction hash
    });

    run_and_expect_successful_inclusion(mock_evm_provider, block_time).await;
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

    // after the tx is sent and gets a tx hash, immediately report it as included
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

    run_and_expect_successful_inclusion(mock_evm_provider, block_time).await;
}

#[tokio::test]
#[traced_test]
async fn test_tx_which_fails_simulation_after_submission_is_delivered() {
    let block_time = Duration::from_millis(20);
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_get_block(&mut mock_evm_provider);
    mock_default_fee_history(&mut mock_evm_provider);
    let mut estimate_gas_call_counter = 0;
    mock_evm_provider
        .expect_estimate_gas_limit()
        .returning(move |_, _| {
            estimate_gas_call_counter += 1;
            // simulation passes on the first call, but fails on the second
            if estimate_gas_call_counter < 2 {
                Ok(21000.into())
            } else {
                Err(ChainCommunicationError::CustomError(
                    "transaction simulation failed".to_string(),
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
                Ok(Some(mock_tx_receipt(Some(42)))) // Block number for the last submission
            }
        });

    // assert sending the tx always works
    mock_evm_provider
        .expect_send()
        .returning(move |_tx, _| Ok(H256::random()));

    run_and_expect_successful_inclusion(mock_evm_provider, block_time).await;
}

struct ExpectedTxState {
    nonce: U256,
    gas_limit: u64,
    // either gas price or max fee per gas
    gas_price: u32,
    priority_fee: Option<u32>,
}

/// Arguments that need explaining:
/// `expected_tx_states` - for each expected iteration of the inclusion stage, we expect the DB to reflect a tx with the following properties
/// arguments
async fn run_and_expect_successful_inclusion(
    expected_tx_states: Vec<ExpectedTxState>,
    mut mock_evm_provider: MockEvmProvider,
    block_time: Duration,
) {
    mock_evm_provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(0)));

    let signer = H160::random();
    let dispatcher_state =
        mock_dispatcher_state_with_provider(mock_evm_provider, signer, block_time);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(100);
    let mut inclusion_stage_pool = Arc::new(Mutex::new(HashMap::new()));

    let created_txs = mock_evm_txs(
        1,
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::PendingInclusion,
        signer,
    )
    .await;
    let created_tx = created_txs[0].clone();
    let mock_domain = "test";
    inclusion_stage_pool
        .lock()
        .await
        .insert(created_tx.uuid.clone(), created_tx.clone());
    // need to manually set this because panics don't propagate through the select! macro
    let mut success = false;

    for expected_tx_state in expected_tx_states {
        InclusionStage::process_txs_step(
            &inclusion_stage_pool,
            &finality_stage_sender,
            &dispatcher_state,
            mock_domain,
        )
        .await
        .unwrap();

        assert_tx_db_state(
            expected_tx_state,
            &dispatcher_state.tx_db,
            &dispatcher_state.payload_db,
            &created_tx,
        )
        .await;
    }

    select! {
        tx_received = finality_stage_receiver.recv() => {
            let tx_received = tx_received.unwrap();
            assert_eq!(tx_received.payload_details[0].uuid, created_tx.payload_details[0].uuid);
            success = true;
        },
        _ = tokio::time::sleep(Duration::from_millis(5000)) => {
            panic!("Inclusion stage did not process the txs in time");
        }
    }
    assert!(
        success,
        "Inclusion stage did not process the txs successfully"
    );
}

async fn assert_tx_db_state(
    expected: ExpectedTxState,
    tx_db: &Arc<dyn TransactionDb>,
    payload_db: &Arc<dyn PayloadDb>,
    created_tx: &Transaction,
) {
    let retrieved_tx = tx_db
        .retrieve_transaction_by_uuid(&created_tx.uuid)
        .await
        .unwrap()
        .unwrap();
    let evm_specific_data = retrieved_tx.precursor().clone().tx;
    assert_eq!(retrieved_tx.status, TransactionStatus::PendingInclusion);

    assert_eq!(
        retrieved_tx.vm_specific_data,
        VmSpecificTxData::Evm(evm_specific_data.clone())
    );
    assert_eq!(retrieved_tx.payload_details, created_tx.payload_details);
    assert_eq!(retrieved_tx.submission_attempts, 1);

    assert_eq!(evm_specific_data.nonce, Some(expected.nonce));
    assert_eq!(evm_specific_data.gas_limit, Some(expected.gas_limit.into()));
    if let TypedTransaction::Eip1559(eip1559_tx) = evm_specific_data.tx {
        assert_eq!(eip1559_tx.from, Some(expected.nonce.into()));
        assert_eq!(eip1559_tx.gas_price, None);
        assert_eq!(eip1559_tx.max_fee_per_gas, Some(expected.gas_price.into()));
        assert_eq!(
            eip1559_tx.max_priority_fee_per_gas,
            expected.priority_fee.map(|fee| fee.into())
        );
    } else {
        panic!(
            "Expected EIP-1559 transaction, but got {:?}",
            evm_specific_data.tx
        );
    }
}

fn mocked_evm_provider() -> MockEvmProvider {
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_finalized_block_number(&mut mock_evm_provider);
    mock_estimate_gas_limit(&mut mock_evm_provider);
    mock_evm_provider.expect_get_block().returning(|_| {
        Ok(Some(Default::default())) // Mocked block retrieval
    });

    mock_evm_provider.expect_send().returning(|_, _| {
        Ok(H256::random()) // Mocked transaction hash
    });
    mock_evm_provider
        .expect_fee_history()
        .returning(|_, _, _| Ok(mock_fee_history(0, 0)));

    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| {
            Ok(Some(TransactionReceipt {
                transaction_hash: H256::random().into(),
                block_number: Some(42.into()),
                ..Default::default()
            }))
        });
    mock_evm_provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::one()));

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
    let adapter = mock_ethereum_adapter(provider, nonce_db, tx_db.clone(), signer, block_time);
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
    nonce_db: Arc<dyn NonceDb>,
    tx_db: Arc<dyn TransactionDb>,
    signer: H160,
    block_time: Duration,
) -> EthereumAdapter {
    let domain: HyperlaneDomain = KnownHyperlaneDomain::Arbitrum.into();
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

    EthereumAdapter {
        estimated_block_time: block_time,
        domain,
        transaction_overrides: Default::default(),
        submission_config: OpSubmissionConfig::default(),
        provider,
        reorg_period,
        nonce_manager,
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
