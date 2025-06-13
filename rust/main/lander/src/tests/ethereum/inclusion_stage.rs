#![allow(deprecated)]

use core::panic;
use std::{
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
use hyperlane_core::{
    config::OpSubmissionConfig, identifiers::UniqueIdentifier, ChainCommunicationError,
    KnownHyperlaneDomain, H256,
};
use hyperlane_ethereum::EthereumReorgPeriod;
use tokio::{select, sync::mpsc};
use tracing_test::traced_test;

use crate::{
    adapter::{
        chains::ethereum::{
            nonce::{db::NonceDb, NonceManager, NonceManagerState},
            tests::MockEvmProvider,
            EthereumAdapter,
        },
        EthereumTxPrecursor,
    },
    dispatcher::{test_utils::tmp_dbs, DispatcherState, InclusionStage, PayloadDb, TransactionDb},
    transaction::{Transaction, VmSpecificTxData},
    DispatcherMetrics, FullPayload, PayloadStatus, TransactionStatus,
};

#[tokio::test]
#[traced_test]
async fn test_inclusion_happy_path() {
    let block_time = Duration::from_millis(10);
    let mock_evm_provider = mocked_evm_provider();

    run_and_expect_successful_inclusion(mock_evm_provider, block_time).await;
}

#[tokio::test]
#[traced_test]
async fn test_inclusion_gas_spike() {
    let block_time = Duration::from_millis(20);
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_evm_provider
        .expect_get_finalized_block_number()
        .returning(|_reorg_period| {
            Ok(43) // Mocked block number
        });
    mock_evm_provider
        .expect_estimate_gas_limit()
        .returning(|_, _| {
            Ok(21000.into()) // Mocked gas limit
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
    let base_processing_delay = Duration::from_millis(100);
    let inclusion_stage_processing_delay = Duration::from_millis(30);
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

    mock_evm_provider
        .expect_get_block()
        .returning(|_| Ok(Some(mock_block(42, 100)))); // Mocked block retrieval

    run_and_expect_successful_inclusion(mock_evm_provider, block_time).await;
}

#[tokio::test]
#[traced_test]
async fn test_inclusion_gas_underpriced() {
    let block_time = Duration::from_millis(20);
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_evm_provider
        .expect_get_finalized_block_number()
        .returning(|_reorg_period| {
            Ok(43) // Mocked block number
        });
    mock_evm_provider
        .expect_estimate_gas_limit()
        .returning(|_, _| {
            Ok(21000.into()) // Mocked gas limit
        });

    mock_evm_provider
        .expect_fee_history()
        .returning(move |_, _, _| Ok(mock_fee_history(200000, 10)));

    // after the tx is sent and gets a tx hash, immediately report it as included
    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| Ok(Some(mock_tx_receipt(Some(42)))));

    // assert each expected price by mocking the `send` method of the provider
    let mut send_call_counter = 0;
    let elapsed = Instant::now();
    let base_processing_delay = Duration::from_millis(100);
    // assume 1 second more than usual because that's the retry delay when an error occurs
    let inclusion_stage_processing_delay = Duration::from_millis(1030);
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

    mock_evm_provider
        .expect_get_block()
        .returning(|_| Ok(Some(mock_block(42, 100)))); // Mocked block retrieval

    run_and_expect_successful_inclusion(mock_evm_provider, block_time).await;
}

async fn run_and_expect_successful_inclusion(
    mock_evm_provider: MockEvmProvider,
    block_time: Duration,
) {
    let signer = H160::random();
    let dispatcher_state =
        mock_dispatcher_state_with_provider(mock_evm_provider, signer, block_time);
    let (tx_sender, tx_receiver) = mpsc::channel(100);
    let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(100);
    let inclusion_stage =
        mock_inclusion_stage(dispatcher_state.clone(), tx_receiver, finality_stage_sender);

    let txs_to_process = 1;
    let txs_created = mock_evm_txs(
        txs_to_process,
        &dispatcher_state.payload_db,
        &dispatcher_state.tx_db,
        TransactionStatus::PendingInclusion,
        signer,
    )
    .await;
    for tx in txs_created.iter() {
        tx_sender.send(tx.clone()).await.unwrap();
    }
    // need to manually set this because panics don't propagate through the select! macro
    let mut success = false;
    select! {
        _ = inclusion_stage.run() => {
            // inclusion stage should process the txs
        },
        tx_received = finality_stage_receiver.recv() => {
            let tx_received = tx_received.unwrap();
            assert_eq!(tx_received.payload_details[0].uuid, txs_created[0].payload_details[0].uuid);
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

fn mocked_evm_provider() -> MockEvmProvider {
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_evm_provider
        .expect_get_finalized_block_number()
        .returning(|_reorg_period| {
            Ok(43) // Mocked block number
        });
    mock_evm_provider
        .expect_estimate_gas_limit()
        .returning(|_, _| {
            Ok(21000.into()) // Mocked gas limit
        });
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
}

fn mock_inclusion_stage(
    state: DispatcherState,
    tx_receiver: mpsc::Receiver<Transaction>,
    finality_stage_sender: mpsc::Sender<Transaction>,
) -> InclusionStage {
    InclusionStage::new(
        tx_receiver,
        finality_stage_sender,
        state,
        "test".to_string(),
    )
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

fn dummy_evm_tx(
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

fn dummy_tx_precursor(signer: H160) -> EthereumTxPrecursor {
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
    let adapter = mock_ethereum_adapter(provider, nonce_db, signer, block_time);
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
    signer: H160,
    block_time: Duration,
) -> EthereumAdapter {
    EthereumAdapter {
        estimated_block_time: block_time,
        domain: KnownHyperlaneDomain::Arbitrum.into(),
        transaction_overrides: Default::default(),
        submission_config: OpSubmissionConfig::default(),
        provider: Box::new(provider),
        reorg_period: EthereumReorgPeriod::Blocks(1),
        nonce_manager: NonceManager {
            address: signer,
            db: nonce_db,
            state: NonceManagerState::new(),
        },
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
