use std::{sync::Arc, time::Duration};

use ethers::{
    abi::AbiParser,
    providers::Provider,
    types::{TransactionRequest, H160},
};
use hyperlane_core::KnownHyperlaneDomain;
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
