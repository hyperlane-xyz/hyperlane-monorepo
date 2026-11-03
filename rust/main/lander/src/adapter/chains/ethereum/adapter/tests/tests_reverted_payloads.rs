use std::{sync::Arc, time::Duration};

use ethers::{
    abi::AbiParser,
    providers::Provider,
    types::{TransactionRequest, H160},
};
use hyperlane_core::{ChainCommunicationError, KnownHyperlaneDomain};
use hyperlane_ethereum::EthereumProvider;
use tokio::sync::Semaphore;

use crate::{
    adapter::{
        chains::ethereum::tests::{
            dummy_evm_tx, ExpectedTxType, MockEvmProvider, YieldingRpcClient,
        },
        AdaptsChain,
    },
    tests::{evm::test_utils::mock_ethereum_adapter, test_utils::tmp_dbs},
    FullPayload, TransactionStatus,
};

use super::super::PAYLOAD_STATUS_READ_CONCURRENCY;

#[tokio::test]
async fn payload_status_reads_are_concurrent_bounded_and_ordered() {
    let first_request_gate = Arc::new(Semaphore::new(0));
    let client = YieldingRpcClient::new([(
        "eth_call",
        serde_json::json!(format!("0x{}", "00".repeat(32))),
    )])
    .with_first_request_gate(first_request_gate.clone());
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let mut adapter = mock_ethereum_adapter(
        MockEvmProvider::new(),
        payload_db,
        tx_db,
        nonce_db,
        H160::zero(),
        Duration::ZERO,
        Duration::ZERO,
    );
    adapter.provider = Arc::new(EthereumProvider::new(
        Arc::new(Provider::new(client.clone())),
        KnownHyperlaneDomain::Ethereum.into(),
    ));
    let function = AbiParser::default()
        .parse_function("function delivered(bytes32) view returns (bool)")
        .expect("parse delivery check ABI");
    let success_criteria =
        serde_json::to_vec(&(
            ethers::types::transaction::eip2718::TypedTransaction::Legacy(
                TransactionRequest::default(),
            ),
            function,
        ))
        .expect("serialize success criteria");
    let payloads: Vec<_> = (0..PAYLOAD_STATUS_READ_CONCURRENCY * 2)
        .map(|_| {
            let mut payload = FullPayload::random();
            payload.details.success_criteria = Some(success_criteria.clone());
            payload
        })
        .collect();
    let tx = dummy_evm_tx(
        ExpectedTxType::Legacy,
        payloads,
        TransactionStatus::Finalized,
        H160::zero(),
    );

    let expected = tx.payload_details.clone();
    let running = tokio::spawn(async move {
        adapter
            .reverted_payloads(&tx)
            .await
            .expect("read payload statuses")
    });
    tokio::time::timeout(
        Duration::from_secs(1),
        client.wait_for_total(PAYLOAD_STATUS_READ_CONCURRENCY * 2),
    )
    .await
    .expect("a slow first read must not prevent admission of later payloads");
    assert!(!running.is_finished());
    first_request_gate.add_permits(1);
    let reverted = running.await.expect("status reader completed");

    assert_eq!(reverted, expected);
    assert_eq!(client.total(), PAYLOAD_STATUS_READ_CONCURRENCY * 2);
    assert_eq!(client.peak(), PAYLOAD_STATUS_READ_CONCURRENCY);
}

#[tokio::test]
async fn payload_status_reads_filter_mixed_results_in_original_order() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let mut provider = MockEvmProvider::new();
    provider
        .expect_check()
        .times(4)
        .returning(|tx, _| Ok(tx.nonce().expect("criteria nonce").as_u64() % 2 == 0));
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db,
        tx_db,
        nonce_db,
        H160::zero(),
        Duration::ZERO,
        Duration::ZERO,
    );
    let function = AbiParser::default()
        .parse_function("function delivered(bytes32) view returns (bool)")
        .expect("parse delivery check ABI");
    let mut payloads: Vec<_> = (0..4u64)
        .map(|index| {
            let mut payload = FullPayload::random();
            payload.details.success_criteria = Some(
                serde_json::to_vec(&(
                    ethers::types::transaction::eip2718::TypedTransaction::Legacy(
                        TransactionRequest::new().nonce(index),
                    ),
                    function.clone(),
                ))
                .expect("serialize success criteria"),
            );
            payload
        })
        .collect();
    // A payload without success criteria must not enter either result group.
    let mut unchecked = FullPayload::random();
    unchecked.details.success_criteria = None;
    payloads.insert(2, unchecked);
    let tx = dummy_evm_tx(
        ExpectedTxType::Legacy,
        payloads,
        TransactionStatus::Finalized,
        H160::zero(),
    );
    let reverted = adapter
        .reverted_payloads(&tx)
        .await
        .expect("check mixed payloads");
    assert_eq!(
        reverted,
        vec![tx.payload_details[1].clone(), tx.payload_details[4].clone()]
    );
}

#[tokio::test]
async fn payload_status_read_errors_propagate_and_can_be_retried() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let mut provider = MockEvmProvider::new();
    let mut sequence = mockall::Sequence::new();
    provider
        .expect_check()
        .times(1)
        .in_sequence(&mut sequence)
        .returning(|_, _| {
            Err(ChainCommunicationError::from_other_str(
                "payload RPC unavailable",
            ))
        });
    provider
        .expect_check()
        .times(1)
        .in_sequence(&mut sequence)
        .returning(|_, _| Ok(false));
    let adapter = mock_ethereum_adapter(
        provider,
        payload_db,
        tx_db,
        nonce_db,
        H160::zero(),
        Duration::ZERO,
        Duration::ZERO,
    );
    let function = AbiParser::default()
        .parse_function("function delivered(bytes32) view returns (bool)")
        .expect("parse delivery check ABI");
    let mut payload = FullPayload::random();
    payload.details.success_criteria =
        Some(
            serde_json::to_vec(&(
                ethers::types::transaction::eip2718::TypedTransaction::Legacy(
                    TransactionRequest::new(),
                ),
                function,
            ))
            .expect("serialize success criteria"),
        );
    let tx = dummy_evm_tx(
        ExpectedTxType::Legacy,
        vec![payload],
        TransactionStatus::Finalized,
        H160::zero(),
    );
    let error = adapter
        .reverted_payloads(&tx)
        .await
        .expect_err("failed checks must retry");
    assert!(error.to_string().contains("payload RPC unavailable"));
    assert_eq!(
        adapter
            .reverted_payloads(&tx)
            .await
            .expect("retry payload check"),
        tx.payload_details
    );
}
