use std::collections::HashMap;
use std::convert::Into;
use std::fmt::Debug;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use async_trait::async_trait;
use ethers::abi::Function;
use ethers::prelude::{Block, BlockNumber, FeeHistory, TransactionReceipt, U256 as EthersU256};
use ethers::providers::{HttpClientError, JsonRpcClient};
use ethers::types::{transaction::eip2718::TypedTransaction, Address, H160, H256 as EthersH256};
use ethers_core::abi::{Param, ParamType, StateMutability};
use ethers_core::types::{Eip1559TransactionRequest, TransactionRequest};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use tokio::sync::{Notify, Semaphore};

use hyperlane_core::identifiers::UniqueIdentifier;
use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneProvider, MerkleTreeHook, H256, U256,
};
use hyperlane_ethereum::multicall::BatchCache;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForLander, ZksyncEstimateFeeResponse};

use crate::adapter::EthereumTxPrecursor;
use crate::transaction::{Transaction, VmSpecificTxData};
use crate::{FullPayload, TransactionStatus};

#[derive(Debug, Default)]
struct RpcActivity {
    active: AtomicUsize,
    peak: AtomicUsize,
    total: AtomicUsize,
    started: Notify,
}

/// A real asynchronous RPC boundary for concurrency regressions. Mockall's
/// async method expectations otherwise return synchronously in these tests.
#[derive(Debug, Clone)]
pub struct YieldingRpcClient {
    responses: Arc<HashMap<&'static str, Value>>,
    activity: Arc<RpcActivity>,
    first_request_gate: Option<Arc<Semaphore>>,
}

impl YieldingRpcClient {
    pub fn new(responses: impl IntoIterator<Item = (&'static str, Value)>) -> Self {
        Self {
            responses: Arc::new(responses.into_iter().collect()),
            activity: Arc::new(RpcActivity::default()),
            first_request_gate: None,
        }
    }

    pub fn with_first_request_gate(mut self, gate: Arc<Semaphore>) -> Self {
        self.first_request_gate = Some(gate);
        self
    }

    pub async fn wait_for_total(&self, total: usize) {
        loop {
            let started = self.activity.started.notified();
            if self.total() >= total {
                return;
            }
            started.await;
        }
    }

    pub fn peak(&self) -> usize {
        self.activity.peak.load(Ordering::Relaxed)
    }

    pub fn total(&self) -> usize {
        self.activity.total.load(Ordering::Relaxed)
    }
}

#[async_trait]
impl JsonRpcClient for YieldingRpcClient {
    type Error = HttpClientError;

    async fn request<T, R>(&self, method: &str, _params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        let response = self.responses.get(method).expect("unexpected RPC method");
        let index = self.activity.total.fetch_add(1, Ordering::Relaxed);
        let active = self.activity.active.fetch_add(1, Ordering::Relaxed) + 1;
        self.activity.peak.fetch_max(active, Ordering::Relaxed);
        self.activity.started.notify_one();
        if index == 0 {
            if let Some(gate) = &self.first_request_gate {
                let _permit = gate.acquire().await.expect("request gate remains open");
            }
        }
        tokio::task::yield_now().await;
        self.activity.active.fetch_sub(1, Ordering::Relaxed);
        serde_json::from_value(response.clone()).map_err(|err| HttpClientError::SerdeJson {
            err,
            text: response.to_string(),
        })
    }
}

mockall::mock! {
    pub EvmProvider {}

    #[async_trait]
    impl EvmProviderForLander for EvmProvider {
        /// Get the transaction receipt for a given transaction hash
        async fn get_transaction_receipt(
            &self,
            transaction_hash: H256,
        ) -> ChainResult<Option<TransactionReceipt>>;

        /// Get the finalized block number
        async fn get_finalized_block_number(
            &self,
            reorg_period: &EthereumReorgPeriod,
        ) -> ChainResult<u32>;

        /// Get the block for a given block number
        async fn get_block(&self, block_number: BlockNumber) -> ChainResult<Option<Block<EthersH256>>>;

        /// Estimate the gas limit for a transaction
        async fn estimate_gas_limit(
            &self,
            tx: &TypedTransaction,
            function: &Function,
        ) -> ChainResult<U256>;

        async fn batch(
            &self,
            cache: Arc<tokio::sync::Mutex<BatchCache>>,
            batch_contract_address: H256,
            precursors: Vec<(TypedTransaction, Function)>,
            signer: H160,
        ) -> ChainResult<(TypedTransaction, Function)>;

        async fn simulate_batch(
            &self,
            multi_precursor: (TypedTransaction, Function),
        ) -> ChainResult<(Vec<usize>, Vec<(usize, String)>)>;

        async fn estimate_batch(
            &self,
            multi_precursor: (TypedTransaction, Function),
            precursors: Vec<(TypedTransaction, Function)>,
        ) -> ChainResult<U256>;

        /// Send transaction into blockchain
        async fn send(&self, tx: &TypedTransaction, function: &Function) -> ChainResult<H256>;

        async fn sign_transaction(&self, tx: &TypedTransaction) -> ChainResult<ethers::types::Bytes>;
        async fn send_raw_transaction(&self, tx: ethers::types::Bytes) -> ChainResult<H256>;

        /// Read-only call into blockchain which returns a boolean
        async fn check(&self, tx: &TypedTransaction, function: &Function) -> ChainResult<bool>;

        /// Get the next nonce to use for a given address (using the finalized block)
        async fn get_next_nonce_on_finalized_block(&self, address: &Address, reorg_period: &EthereumReorgPeriod) -> ChainResult<U256>;

        /// Get the fee history
        async fn fee_history(
            &self,
            block_count: U256,
            last_block: BlockNumber,
            reward_percentiles: &[f64],
        ) -> ChainResult<FeeHistory>;

        /// Estimate the fee for a zkSync transaction
        async fn zk_estimate_fee(
            &self,
            tx: &TypedTransaction,
        ) -> ChainResult<ZksyncEstimateFeeResponse>;

        /// Get default sender
        fn get_signer(&self) -> Option<H160>;
        async fn get_chain_id(&self) -> ChainResult<u64>;
    }
}

/// Expected transaction type for assertions in tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpectedTxType {
    Legacy,
    Eip1559,
    Eip2930,
}

pub struct ExpectedEvmTxState {
    pub nonce: Option<EthersU256>,
    pub gas_limit: Option<EthersU256>,
    // either gas price or max fee per gas
    pub gas_price: Option<EthersU256>, // changed from EthersU256 to Option<EthersU256>
    pub priority_fee: Option<EthersU256>,
    pub status: TransactionStatus,
    pub retries: u32,
    pub tx_type: ExpectedTxType,
}

pub fn dummy_evm_tx(
    tx_type: ExpectedTxType,
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
        vm_specific_data: VmSpecificTxData::Evm(Box::new(dummy_tx_precursor(tx_type, signer))),
        payload_details: details.clone(),
        status,
        submission_attempts: 0,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
        last_status_check: None,
    }
}

pub fn dummy_tx_precursor(tx_type: ExpectedTxType, signer: H160) -> EthereumTxPrecursor {
    let to = ethers::types::NameOrAddress::Address(H160::random());
    let function = dummy_evm_function();
    let tx = match tx_type {
        ExpectedTxType::Eip1559 => TypedTransaction::Eip1559(Eip1559TransactionRequest {
            from: Some(signer),
            to: Some(to), // Random recipient address
            gas: None,
            value: None,
            data: None,
            nonce: None,
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            chain_id: None,
            ..Default::default()
        }),
        ExpectedTxType::Legacy => TypedTransaction::Legacy(TransactionRequest {
            from: Some(signer),
            to: Some(to),
            gas: None,
            gas_price: None,
            value: Some(0u64.into()),
            data: None,
            nonce: None,
            ..Default::default()
        }),
        ExpectedTxType::Eip2930 => todo!(),
    };
    EthereumTxPrecursor { tx, function }
}

pub fn dummy_evm_function() -> Function {
    #[allow(deprecated)]
    Function {
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
    }
}
