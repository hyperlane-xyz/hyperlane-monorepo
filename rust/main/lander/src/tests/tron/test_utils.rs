use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ethers::abi::{Detokenize, Function, Param, ParamType, StateMutability, Token};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::{TransactionReceipt, TransactionRequest, U256, U64};

use hyperlane_core::{ChainCommunicationError, ChainResult, H256, H512};
use hyperlane_tron::TronProviderForLander;

/// Mock Tron provider for integration testing
///
/// Provides configurable behavior for all TronProviderForLander methods.
/// Use the builder pattern methods to configure return values for each test scenario.
#[derive(Clone)]
pub struct MockTronProvider {
    /// Configurable gas estimate to return
    gas_estimate: Arc<Mutex<Option<U256>>>,
    /// Configurable receipts by hash
    receipts: Arc<Mutex<HashMap<H512, Option<TransactionReceipt>>>>,
    /// Finalized block number
    finalized_block: Arc<Mutex<Result<u32, String>>>,
    /// Should submit_tx fail
    submit_error: Arc<Mutex<Option<String>>>,
    /// Should estimate_gas fail
    estimate_error: Arc<Mutex<Option<String>>>,
    /// Result of call<bool> for success_criteria
    call_result: Arc<Mutex<Result<bool, String>>>,
    /// Counter for submit attempts (for testing retry logic)
    submit_counter: Arc<Mutex<u32>>,
    /// Maximum submit failures before success (for testing retries)
    max_submit_failures: Arc<Mutex<u32>>,
}

impl Default for MockTronProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl MockTronProvider {
    pub fn new() -> Self {
        Self {
            gas_estimate: Arc::new(Mutex::new(Some(U256::from(100_000)))),
            receipts: Arc::new(Mutex::new(HashMap::new())),
            finalized_block: Arc::new(Mutex::new(Ok(100))),
            submit_error: Arc::new(Mutex::new(None)),
            estimate_error: Arc::new(Mutex::new(None)),
            call_result: Arc::new(Mutex::new(Ok(true))),
            submit_counter: Arc::new(Mutex::new(0)),
            max_submit_failures: Arc::new(Mutex::new(0)),
        }
    }

    pub fn with_gas_estimate(self, gas: U256) -> Self {
        *self.gas_estimate.lock().unwrap() = Some(gas);
        self
    }

    pub fn with_estimate_error(self, error: &str) -> Self {
        *self.estimate_error.lock().unwrap() = Some(error.to_string());
        self
    }

    pub fn with_submit_error(self, error: &str) -> Self {
        *self.submit_error.lock().unwrap() = Some(error.to_string());
        self
    }

    /// Configure the provider to fail submit N times before succeeding
    pub fn with_submit_failures(self, count: u32) -> Self {
        *self.max_submit_failures.lock().unwrap() = count;
        self
    }

    pub fn with_receipt(self, hash: H512, receipt: Option<TransactionReceipt>) -> Self {
        self.receipts.lock().unwrap().insert(hash, receipt);
        self
    }

    pub fn with_finalized_block(self, block: u32) -> Self {
        *self.finalized_block.lock().unwrap() = Ok(block);
        self
    }

    pub fn with_finalized_block_error(self, error: &str) -> Self {
        *self.finalized_block.lock().unwrap() = Err(error.to_string());
        self
    }

    pub fn with_call_result(self, result: bool) -> Self {
        *self.call_result.lock().unwrap() = Ok(result);
        self
    }

    pub fn with_call_error(self, error: &str) -> Self {
        *self.call_result.lock().unwrap() = Err(error.to_string());
        self
    }

    /// Get the number of submit attempts made
    pub fn get_submit_count(&self) -> u32 {
        *self.submit_counter.lock().unwrap()
    }
}

#[async_trait]
impl TronProviderForLander for MockTronProvider {
    async fn get_transaction_receipt(
        &self,
        transaction_hash: H512,
    ) -> ChainResult<Option<TransactionReceipt>> {
        let receipts = self.receipts.lock().unwrap();
        match receipts.get(&transaction_hash) {
            Some(receipt) => Ok(receipt.clone()),
            None => Ok(None),
        }
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let result = self.finalized_block.lock().unwrap().clone();
        result.map_err(|e| ChainCommunicationError::from_other_str(&e))
    }

    async fn submit_tx(&self, _tx: &TypedTransaction) -> ChainResult<H256> {
        // Increment counter
        let mut counter = self.submit_counter.lock().unwrap();
        *counter += 1;
        let current_count = *counter;
        drop(counter);

        // Check for permanent error
        let error = self.submit_error.lock().unwrap().clone();
        if let Some(err) = error {
            return Err(ChainCommunicationError::from_other_str(&err));
        }

        // Check for temporary failures (for retry testing)
        let max_failures = *self.max_submit_failures.lock().unwrap();
        if current_count <= max_failures {
            return Err(ChainCommunicationError::from_other_str(
                "Mock: temporary submission failure",
            ));
        }

        Ok(H256::random())
    }

    async fn estimate_gas(&self, _tx: &TypedTransaction) -> ChainResult<U256> {
        let error = self.estimate_error.lock().unwrap().clone();
        if let Some(err) = error {
            return Err(ChainCommunicationError::from_other_str(&err));
        }

        let gas = self.gas_estimate.lock().unwrap();
        Ok(gas.unwrap_or(U256::from(21_000)))
    }

    async fn call<T: Detokenize>(
        &self,
        _tx: &TypedTransaction,
        _function: &Function,
    ) -> ChainResult<T> {
        let result = self.call_result.lock().unwrap().clone();
        match result {
            Ok(success) => {
                // We need to handle the case where T is bool
                let token = Token::Bool(success);
                T::from_tokens(vec![token]).map_err(|e| {
                    ChainCommunicationError::from_other_str(&format!(
                        "Failed to decode token: {}",
                        e
                    ))
                })
            }
            Err(e) => Err(ChainCommunicationError::from_other_str(&e)),
        }
    }
}

/// Helper function to create a test Tron function for use in precursors
pub fn create_test_function() -> Function {
    Function {
        name: "testFunction".to_string(),
        inputs: vec![Param {
            name: "value".to_string(),
            kind: ParamType::Uint(256),
            internal_type: None,
        }],
        outputs: vec![Param {
            name: "success".to_string(),
            kind: ParamType::Bool,
            internal_type: None,
        }],
        constant: None,
        state_mutability: StateMutability::NonPayable,
    }
}

/// Helper function to create a test TypedTransaction for use in precursors
pub fn create_test_tx_request() -> TypedTransaction {
    let request = TransactionRequest::new()
        .to(ethers::types::H160::from_low_u64_be(0x1234))
        .value(0)
        .data(vec![0x01, 0x02, 0x03, 0x04]);
    TypedTransaction::Legacy(request)
}

/// Helper function to create a test TransactionReceipt with optional block number
pub fn create_receipt_with_block(block_number: Option<u64>) -> TransactionReceipt {
    TransactionReceipt {
        transaction_hash: H256::random().into(),
        transaction_index: 0.into(),
        block_hash: Some(H256::random().into()),
        block_number: block_number.map(U64::from),
        from: ethers::types::H160::zero(),
        to: Some(ethers::types::H160::zero()),
        cumulative_gas_used: U256::zero(),
        gas_used: Some(U256::from(21_000)),
        contract_address: None,
        logs: vec![],
        status: Some(U64::from(1)),
        root: None,
        logs_bloom: Default::default(),
        transaction_type: None,
        effective_gas_price: None,
    }
}
