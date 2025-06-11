#![allow(deprecated)]

use core::panic;
use std::{sync::Arc, time::Duration};

use ethers::{
    abi::{Function, Param, ParamType, StateMutability},
    types::{
        transaction::eip2718::TypedTransaction, Eip1559TransactionRequest, TransactionReceipt,
        H160, H256 as EthersH256,
    },
};
use hyperlane_core::{
    config::OpSubmissionConfig, identifiers::UniqueIdentifier, KnownHyperlaneDomain, H256,
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
    let mock_evm_provider = mocked_evm_provider();
    let signer = H160::random();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_evm_provider, signer);
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
    select! {
        _ = inclusion_stage.run() => {
            // inclusion stage should process the txs
        },
        tx_received = finality_stage_receiver.recv() => {
            let tx_received = tx_received.unwrap();
            assert_eq!(tx_received.payload_details[0].uuid, txs_created[0].payload_details[0].uuid);
        },
        _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
            panic!("Inclusion stage did not process the txs in time");
        }
    }
}

#[tokio::test]
#[traced_test]
async fn test_inclusion_gas_spike() {
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

    // first submission, price is 100
    // second submission, price is 109 (less than 10% spike)
    // third submission, price is 110 (less than 10% spike)
    // fourth submission, price is 150 (greater than 10% spike)
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

    // return mock receipt than has no block for first 3 submissions, then full receipt for the last one
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
    mock_evm_provider.expect_send().returning(move |tx, _| {
        send_call_counter += 1;
        match send_call_counter {
            1 => {
                assert_eq!(tx.gas_price().unwrap(), 200000.into())
            }
            2 => {
                assert_eq!(tx.gas_price().unwrap(), 220000.into()) // Second submission, price is 10% higher, even though the spike was smaller
            }
            3 => {
                assert_eq!(tx.gas_price().unwrap(), 242000.into()) // Third submission, price is 10% higher again, even though the spike was smaller
            }
            4 => {
                assert_eq!(tx.gas_price().unwrap(), 300000.into()) // Fourth submission, price matches the spike
            }
            _ => {}
        }
        Ok(H256::random()) // Mocked transaction hash
    });

    mock_evm_provider
        .expect_get_block()
        .returning(|_| Ok(Some(mock_block(42, 100)))); // Mocked block retrieval

    let signer = H160::random();
    let dispatcher_state = mock_dispatcher_state_with_provider(mock_evm_provider, signer);
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
    select! {
        _ = inclusion_stage.run() => {
            // inclusion stage should process the txs
        },
        tx_received = finality_stage_receiver.recv() => {
            let tx_received = tx_received.unwrap();
            assert_eq!(tx_received.payload_details[0].uuid, txs_created[0].payload_details[0].uuid);
        },
        _ = tokio::time::sleep(tokio::time::Duration::from_millis(5000)) => {
            panic!("Inclusion stage did not process the txs in time");
        }
    }
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
) -> DispatcherState {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let adapter = mock_ethereum_adapter(provider, nonce_db, signer);
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
) -> EthereumAdapter {
    EthereumAdapter {
        estimated_block_time: Duration::from_millis(10),
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
        ..Default::default()
    }
}
