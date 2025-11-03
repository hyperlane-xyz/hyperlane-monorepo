use std::sync::Arc;
use std::time::Duration;

use ethers::abi::{Function, StateMutability};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::transaction::eip2930::AccessList;
use ethers::types::{Address, Eip1559TransactionRequest, NameOrAddress, U256, U64};
use ethers::utils::hex;
use eyre::Result;

use hyperlane_core::config::OpSubmissionConfig;
use hyperlane_core::{
    ChainCommunicationError, Encode, HyperlaneCustomErrorWrapper, HyperlaneMessage,
    KnownHyperlaneDomain, H256,
};
use hyperlane_ethereum::multicall::BatchCache;
use hyperlane_ethereum::TransactionOverrides;
use tokio::sync::Mutex;

use crate::adapter::chains::ethereum::metrics::{
    LABEL_BATCHED_TRANSACTION_FAILED, LABEL_BATCHED_TRANSACTION_SUCCESS,
};
use crate::adapter::chains::ethereum::tests::MockEvmProvider;
use crate::adapter::chains::ethereum::{
    EthereumAdapter, EthereumAdapterMetrics, NonceManager, NonceManagerState, NonceUpdater,
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

#[tokio::test]
async fn test_build_transactions_contract_batch_happy_path() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let mut provider = MockEvmProvider::new();
    // batching will succeed
    provider.expect_batch().returning(|_, _, _, _| {
        let typed_tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(Address::random()),
            to: Some(NameOrAddress::Address(Address::random())),
            gas: Some(U256::from(1200)),
            value: None,
            data: None,
            nonce: Some(U256::from(1000)),
            access_list: AccessList::default(),
            max_fee_per_gas: Some(U256::from(1000)),
            max_priority_fee_per_gas: Some(U256::from(1000)),
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
        Ok((typed_tx, function))
    });

    let signer = Address::random();
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

    let typed_tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
        from: Some(Address::random()),
        to: Some(NameOrAddress::Address(Address::random())),
        gas: Some(U256::from(1200)),
        value: None,
        data: None,
        nonce: Some(U256::from(1000)),
        access_list: AccessList::default(),
        max_fee_per_gas: Some(U256::from(1000)),
        max_priority_fee_per_gas: Some(U256::from(1000)),
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

    let data = (typed_tx, function);
    let json_data = serde_json::to_vec(&data).expect("Failed to serialize data");

    let mut payload1 = FullPayload::random();
    payload1.data = json_data.clone();

    let mut payload2 = FullPayload::random();
    payload2.data = json_data.clone();

    let payloads = vec![payload1, payload2];
    let res = adapter.build_transactions(&payloads).await;

    // We should've succeeded batching
    assert_eq!(res.len(), 1);

    // Make sure we actually successfully built the txs.
    for payload in res {
        assert!(payload.maybe_tx.is_some());
    }

    assert_eq!(
        adapter
            .metrics()
            .get_batched_transactions()
            .get_metric_with_label_values(&["test1", LABEL_BATCHED_TRANSACTION_SUCCESS])
            .expect("Failed to get metrics")
            .get(),
        2
    );

    assert_eq!(
        adapter
            .metrics()
            .get_batched_transactions()
            .get_metric_with_label_values(&["test1", LABEL_BATCHED_TRANSACTION_FAILED])
            .expect("Failed to get metrics")
            .get(),
        0
    );
}

#[tokio::test]
async fn test_build_transactions_batch_contract_missing() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let mut provider = MockEvmProvider::new();
    // batching will fail because contract is missing
    provider
        .expect_batch()
        .returning(|_, _, _, _| Err(ChainCommunicationError::ContractNotFound("test".into())));

    let signer = Address::random();
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

    let typed_tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
        from: Some(Address::random()),
        to: Some(NameOrAddress::Address(Address::random())),
        gas: Some(U256::from(1200)),
        value: None,
        data: None,
        nonce: Some(U256::from(1000)),
        access_list: AccessList::default(),
        max_fee_per_gas: Some(U256::from(1000)),
        max_priority_fee_per_gas: Some(U256::from(1000)),
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

    let data = (typed_tx, function);
    let json_data = serde_json::to_vec(&data).expect("Failed to serialize data");

    let mut payload1 = FullPayload::random();
    payload1.data = json_data.clone();

    let mut payload2 = FullPayload::random();
    payload2.data = json_data.clone();

    let payloads = vec![payload1, payload2];
    let res = adapter.build_transactions(&payloads).await;

    // We should've failed batching and reverted to single tx submission instead.
    assert_eq!(res.len(), payloads.len());

    // Make sure we actually successfully built the txs.
    for payload in res {
        assert!(payload.maybe_tx.is_some());
    }

    assert_eq!(
        adapter
            .metrics()
            .get_batched_transactions()
            .get_metric_with_label_values(&["test1", LABEL_BATCHED_TRANSACTION_SUCCESS])
            .expect("Failed to get metrics")
            .get(),
        0
    );

    assert_eq!(
        adapter
            .metrics()
            .get_batched_transactions()
            .get_metric_with_label_values(&["test1", LABEL_BATCHED_TRANSACTION_FAILED])
            .expect("Failed to get metrics")
            .get(),
        2
    );
}

#[tokio::test]
async fn test_build_transactions_contract_batch_is_empty() {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();

    let mut provider = MockEvmProvider::new();
    // batching will fail because contract is missing
    provider
        .expect_batch()
        .returning(|_, _, _, _| Err(ChainCommunicationError::BatchIsEmpty));

    let signer = Address::random();
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

    let typed_tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
        from: Some(Address::random()),
        to: Some(NameOrAddress::Address(Address::random())),
        gas: Some(U256::from(1200)),
        value: None,
        data: None,
        nonce: Some(U256::from(1000)),
        access_list: AccessList::default(),
        max_fee_per_gas: Some(U256::from(1000)),
        max_priority_fee_per_gas: Some(U256::from(1000)),
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

    let data = (typed_tx, function);
    let json_data = serde_json::to_vec(&data).expect("Failed to serialize data");

    let mut payload1 = FullPayload::random();
    payload1.data = json_data.clone();

    let mut payload2 = FullPayload::random();
    payload2.data = json_data.clone();

    let payloads = vec![payload1, payload2];
    let res = adapter.build_transactions(&payloads).await;

    // We should've failed batching and reverted to single tx submission instead.
    assert_eq!(res.len(), payloads.len());

    // Make sure we actually successfully built the txs.
    for payload in res {
        assert!(payload.maybe_tx.is_some());
    }

    assert_eq!(
        adapter
            .metrics()
            .get_batched_transactions()
            .get_metric_with_label_values(&["test1", LABEL_BATCHED_TRANSACTION_SUCCESS])
            .expect("Failed to get metrics")
            .get(),
        0
    );

    assert_eq!(
        adapter
            .metrics()
            .get_batched_transactions()
            .get_metric_with_label_values(&["test1", LABEL_BATCHED_TRANSACTION_FAILED])
            .expect("Failed to get metrics")
            .get(),
        2
    );
}
