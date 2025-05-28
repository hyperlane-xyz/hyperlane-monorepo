#![allow(deprecated)]

use core::panic;
use std::{sync::Arc, time::Duration};

use ethers::{
    abi::{Function, Param, ParamType, StateMutability},
    types::{
        transaction::eip2718::TypedTransaction, Eip1559TransactionRequest, TransactionReceipt, H160,
    },
};
use tokio::{select, sync::mpsc};
use tracing_test::traced_test;

use hyperlane_core::{
    config::OpSubmissionConfig, identifiers::UniqueIdentifier, KnownHyperlaneDomain, H256,
};
use hyperlane_ethereum::EthereumReorgPeriod;

use crate::{
    adapter::{
        chains::ethereum::{
            nonce::{db::NonceDb, NonceManager, NonceManagerState, NonceUpdater},
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
async fn test_evm_tx_underpriced() {
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

fn mocked_evm_provider() -> MockEvmProvider {
    let mut mock_evm_provider = MockEvmProvider::new();
    mock_evm_provider
        .expect_get_finalized_block_number()
        .returning(|_reorg_period| {
            Ok(42) // Mocked block number
        });
    mock_evm_provider.expect_get_block().returning(|_| {
        Ok(Some(Default::default())) // Mocked block retrieval
    });
    mock_evm_provider
        .expect_estimate_gas_limit()
        .returning(|_, _| {
            Ok(21000.into()) // Mocked gas limit
        });
    mock_evm_provider.expect_send().returning(|_, _| {
        Ok(H256::random()) // Mocked transaction hash
    });
    mock_evm_provider
        .expect_fee_history()
        .returning(|_, _, _| Ok(mock_fee_history()));

    mock_evm_provider
        .expect_get_transaction_receipt()
        .returning(move |_| {
            Ok(Some(TransactionReceipt {
                transaction_hash: H256::random().into(),
                block_number: Some(42.into()),
                ..Default::default()
            }))
        });

    // mock finalized block number to be greater than the tx block number
    mock_evm_provider
        .expect_get_finalized_block_number()
        .returning(|_| Ok(43)); // Mocked finalized block number

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
    let provider = Arc::new(provider);
    let reorg_period = EthereumReorgPeriod::Blocks(1);
    let state = Arc::new(NonceManagerState::new());

    let nonce_updater = NonceUpdater::new(
        signer,
        reorg_period,
        Duration::from_millis(10),
        provider.clone(),
        state.clone(),
    );

    let nonce_manager = NonceManager {
        address: signer,
        db: nonce_db,
        state,
        nonce_updater,
    };

    EthereumAdapter {
        estimated_block_time: Duration::from_millis(10),
        domain: KnownHyperlaneDomain::Arbitrum.into(),
        transaction_overrides: Default::default(),
        submission_config: OpSubmissionConfig::default(),
        provider,
        reorg_period,
        nonce_manager,
    }
}

fn mock_fee_history() -> ethers::types::FeeHistory {
    ethers::types::FeeHistory {
        oldest_block: 0.into(),
        reward: vec![vec![0.into()]],
        base_fee_per_gas: vec![0.into()],
        gas_used_ratio: vec![0.0],
    }
}
