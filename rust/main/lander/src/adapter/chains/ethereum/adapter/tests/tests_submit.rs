use std::sync::Arc;
use std::time::Duration;

use ethers::abi::{Function, StateMutability};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::transaction::eip2930::AccessList;
use ethers::types::{
    Address, Eip1559TransactionRequest, NameOrAddress, H160, U256 as EthersU256, U64,
};
use ethers::utils::hex;
use eyre::Result;

use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::{
    ChainCommunicationError, Encode, HyperlaneCustomErrorWrapper, HyperlaneMessage,
    KnownHyperlaneDomain, H256, U256,
};
use hyperlane_ethereum::multicall::BatchCache;
use hyperlane_ethereum::TransactionOverrides;
use solana_client::client_error::reqwest;
use tokio::sync::Mutex;

use crate::adapter::chains::ethereum::metrics::{
    LABEL_BATCHED_TRANSACTION_FAILED, LABEL_BATCHED_TRANSACTION_SUCCESS,
};
use crate::adapter::chains::ethereum::tests::{dummy_evm_tx, ExpectedTxType, MockEvmProvider};
use crate::adapter::chains::ethereum::{
    EthereumAdapter, EthereumAdapterMetrics, NonceManager, NonceManagerState, NonceUpdater,
    Precursor,
};
use crate::adapter::chains::radix::adapter::tests::tests_common::{
    payload, MockRadixProvider, MAILBOX_ADDRESS, TEST_PRIVATE_KEY,
};
use crate::adapter::{AdaptsChain, TxBuildingResult};
use crate::payload::PayloadDetails;
use crate::tests::evm::test_utils::mock_ethereum_adapter;
use crate::tests::test_utils::tmp_dbs;
use crate::transaction::VmSpecificTxData;
use crate::FullPayload;

fn build_mock_typed_tx_and_function() -> (TypedTransaction, Function) {
    let typed_tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
        from: Some(Address::random()),
        to: Some(NameOrAddress::Address(Address::random())),
        gas: Some(EthersU256::from(1200)),
        value: None,
        data: None,
        nonce: Some(EthersU256::from(1000)),
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

#[tokio::test]
async fn test_calculate_nonce_tx_and_db_equal() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();

    let mut provider = MockEvmProvider::new();
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(100)));

    let data = build_mock_typed_tx_and_function();
    let json_data = serde_json::to_vec(&data).expect("Failed to serialize data");

    let mut payload1 = FullPayload::random();
    payload1.data = json_data.clone();
    let mut payload2 = FullPayload::random();
    payload2.data = json_data.clone();

    let payloads = vec![payload1, payload2];
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        payloads,
        crate::TransactionStatus::Included,
        H160::random(),
    );

    let nonce = EthersU256::from(100);
    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(nonce);
    precursor.tx.set_from(signer.clone());

    nonce_db
        .store_nonce_by_transaction_uuid(&signer, &tx.uuid, &U256::from(nonce))
        .await
        .expect("Failed to store tx nonce");

    let block_time = Duration::from_millis(100);
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

    let nonce_resp = adapter
        .calculate_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    assert_eq!(nonce_resp, U256::from(nonce));
    assert_eq!(adapter.metrics().get_mismatched_nonce().get(), 0);
}

#[tokio::test]
async fn test_calculate_nonce_tx_and_db_mismatch() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let signer = Address::random();

    let mut provider = MockEvmProvider::new();
    provider
        .expect_get_next_nonce_on_finalized_block()
        .returning(|_, _| Ok(U256::from(90)));

    let data = build_mock_typed_tx_and_function();
    let json_data = serde_json::to_vec(&data).expect("Failed to serialize data");

    let mut payload1 = FullPayload::random();
    payload1.data = json_data.clone();
    let mut payload2 = FullPayload::random();
    payload2.data = json_data.clone();

    let payloads = vec![payload1, payload2];
    let mut tx = dummy_evm_tx(
        ExpectedTxType::Eip1559,
        payloads,
        crate::TransactionStatus::Included,
        H160::random(),
    );

    let nonce = EthersU256::from(100);
    let precursor = tx.precursor_mut();
    precursor.tx.set_nonce(nonce);
    precursor.tx.set_from(signer.clone());

    nonce_db
        .store_nonce_by_transaction_uuid(&signer, &tx.uuid, &U256::from(90))
        .await
        .expect("Failed to store tx nonce");

    let block_time = Duration::from_millis(100);
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

    let nonce_resp = adapter
        .calculate_nonce(&tx)
        .await
        .expect("Failed to calculate nonce");

    assert_eq!(nonce_resp, U256::from(90));

    assert_eq!(adapter.metrics().get_mismatched_nonce().get(), 1);
}
