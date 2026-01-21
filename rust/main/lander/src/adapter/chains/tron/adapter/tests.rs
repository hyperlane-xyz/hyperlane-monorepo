use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ethers::abi::{Detokenize, Function, Param, ParamType, StateMutability, Token};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::{TransactionReceipt, TransactionRequest, U256, U64};

use hyperlane_core::{ChainCommunicationError, ChainResult, H256, H512};
use hyperlane_tron::TronProviderForLander;

use crate::adapter::chains::tron::{Precursor, TronTxPrecursor};
use crate::adapter::AdaptsChain;
use crate::payload::{FullPayload, PayloadDetails, PayloadStatus};
use crate::transaction::{Transaction, TransactionStatus, VmSpecificTxData};
use crate::{LanderError, PayloadUuid, TransactionUuid};

/// Configurable mock provider for testing TronAdapter
///
/// Tracks all method calls and allows configuring return values for each method.
#[derive(Clone)]
pub struct MockTronProvider {
    /// Track calls made to the provider
    calls: Arc<Mutex<Vec<MockCall>>>,
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
    /// Track submitted tx hashes
    submitted_tx_hash: Arc<Mutex<Option<H256>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MockCall {
    GetTransactionReceipt(H512),
    GetFinalizedBlockNumber,
    SubmitTx,
    EstimateGas,
    Call,
}

impl Default for MockTronProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl MockTronProvider {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            gas_estimate: Arc::new(Mutex::new(Some(U256::from(100_000)))),
            receipts: Arc::new(Mutex::new(HashMap::new())),
            finalized_block: Arc::new(Mutex::new(Ok(100))),
            submit_error: Arc::new(Mutex::new(None)),
            estimate_error: Arc::new(Mutex::new(None)),
            call_result: Arc::new(Mutex::new(Ok(true))),
            submitted_tx_hash: Arc::new(Mutex::new(None)),
        }
    }

    pub fn get_calls(&self) -> Vec<MockCall> {
        self.calls.lock().unwrap().clone()
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

    pub fn with_submitted_tx_hash(self, hash: H256) -> Self {
        *self.submitted_tx_hash.lock().unwrap() = Some(hash);
        self
    }
}

#[async_trait]
impl TronProviderForLander for MockTronProvider {
    async fn get_transaction_receipt(
        &self,
        transaction_hash: H512,
    ) -> ChainResult<Option<TransactionReceipt>> {
        self.calls
            .lock()
            .unwrap()
            .push(MockCall::GetTransactionReceipt(transaction_hash));

        let receipts = self.receipts.lock().unwrap();
        match receipts.get(&transaction_hash) {
            Some(receipt) => Ok(receipt.clone()),
            None => Ok(None),
        }
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.calls
            .lock()
            .unwrap()
            .push(MockCall::GetFinalizedBlockNumber);

        let result = self.finalized_block.lock().unwrap().clone();
        result.map_err(|e| ChainCommunicationError::from_other_str(&e))
    }

    async fn submit_tx(&self, _tx: &TypedTransaction) -> ChainResult<H256> {
        self.calls.lock().unwrap().push(MockCall::SubmitTx);

        let error = self.submit_error.lock().unwrap().clone();
        if let Some(err) = error {
            return Err(ChainCommunicationError::from_other_str(&err));
        }

        let hash = self
            .submitted_tx_hash
            .lock()
            .unwrap()
            .unwrap_or_else(H256::random);
        Ok(hash)
    }

    async fn estimate_gas(&self, _tx: &TypedTransaction) -> ChainResult<U256> {
        self.calls.lock().unwrap().push(MockCall::EstimateGas);

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
        self.calls.lock().unwrap().push(MockCall::Call);

        let result = self.call_result.lock().unwrap().clone();
        match result {
            Ok(success) => {
                // We need to handle the case where T is bool
                // This is a workaround since we can't directly cast
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

// ============================================================================
// Test Helper Functions
// ============================================================================

fn create_test_function() -> Function {
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

fn create_test_tx_request() -> TypedTransaction {
    let request = TransactionRequest::new()
        .to(ethers::types::H160::from_low_u64_be(0x1234))
        .value(0)
        .data(vec![0x01, 0x02, 0x03, 0x04]);
    TypedTransaction::Legacy(request)
}

fn create_test_precursor() -> TronTxPrecursor {
    TronTxPrecursor::new(create_test_tx_request(), create_test_function())
}

fn create_test_payload() -> FullPayload {
    create_test_payload_with_criteria(None)
}

fn create_test_payload_with_criteria(success_criteria: Option<Vec<u8>>) -> FullPayload {
    let precursor = create_test_precursor();
    let data = serde_json::to_vec(&(&precursor.tx, &precursor.function))
        .expect("Failed to serialize precursor");

    let payload_uuid = PayloadUuid::random();

    FullPayload {
        details: PayloadDetails {
            uuid: payload_uuid.clone(),
            metadata: format!("test-payload-{}", payload_uuid),
            success_criteria,
        },
        data,
        to: H256::zero(),
        status: PayloadStatus::ReadyToSubmit,
        value: None,
        inclusion_soft_deadline: None,
    }
}

fn create_test_payload_with_serialized_criteria() -> FullPayload {
    let precursor = create_test_precursor();
    let data = serde_json::to_vec(&(&precursor.tx, &precursor.function))
        .expect("Failed to serialize precursor");
    let success_criteria = Some(data.clone());

    let payload_uuid = PayloadUuid::random();

    FullPayload {
        details: PayloadDetails {
            uuid: payload_uuid.clone(),
            metadata: format!("test-payload-{}", payload_uuid),
            success_criteria,
        },
        data,
        to: H256::zero(),
        status: PayloadStatus::ReadyToSubmit,
        value: None,
        inclusion_soft_deadline: None,
    }
}

fn create_test_transaction() -> Transaction {
    let precursor = create_test_precursor();
    let payload_uuid = PayloadUuid::random();

    Transaction::new(
        precursor,
        vec![PayloadDetails {
            uuid: payload_uuid.clone(),
            metadata: format!("test-payload-{}", payload_uuid),
            success_criteria: None,
        }],
    )
}

fn create_test_transaction_with_criteria() -> Transaction {
    let precursor = create_test_precursor();
    let payload_uuid = PayloadUuid::random();

    // Create the success criteria as serialized (tx, function) pair
    let criteria =
        serde_json::to_vec(&(&precursor.tx, &precursor.function)).expect("Failed to serialize");

    Transaction::new(
        precursor,
        vec![PayloadDetails {
            uuid: payload_uuid.clone(),
            metadata: format!("test-payload-{}", payload_uuid),
            success_criteria: Some(criteria),
        }],
    )
}

fn create_test_adapter(provider: MockTronProvider) -> super::TronAdapter<MockTronProvider> {
    super::TronAdapter {
        provider: Arc::new(provider),
        estimated_block_time: Duration::from_secs(3),
    }
}

fn create_receipt_with_block(block_number: Option<u64>) -> TransactionReceipt {
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

// ============================================================================
// build_transactions Tests
// ============================================================================

#[tokio::test]
async fn test_build_transactions_single_payload_success() {
    let provider = MockTronProvider::new();
    let adapter = create_test_adapter(provider);

    let payload = create_test_payload();
    let payloads = vec![payload.clone()];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 1, "Should return one result per payload");
    assert!(results[0].maybe_tx.is_some(), "Should have a transaction");
    assert_eq!(
        results[0].payloads.len(),
        1,
        "Should have one payload in result"
    );
    assert_eq!(
        results[0].payloads[0].uuid, payload.details.uuid,
        "Payload UUID should match"
    );

    let tx = results[0].maybe_tx.as_ref().unwrap();
    assert_eq!(
        tx.status,
        TransactionStatus::PendingInclusion,
        "Transaction should be pending inclusion"
    );
    assert!(tx.tx_hashes.is_empty(), "No tx hashes initially");
    assert_eq!(
        tx.payload_details.len(),
        1,
        "Should have one payload detail"
    );
}

#[tokio::test]
async fn test_build_transactions_multiple_payloads() {
    let provider = MockTronProvider::new();
    let adapter = create_test_adapter(provider);

    let payload1 = create_test_payload();
    let payload2 = create_test_payload();
    let payload3 = create_test_payload();
    let payloads = vec![payload1.clone(), payload2.clone(), payload3.clone()];

    let results = adapter.build_transactions(&payloads).await;

    // Tron doesn't support batching, so each payload gets its own transaction
    assert_eq!(results.len(), 3, "Should return one result per payload");

    for (i, result) in results.iter().enumerate() {
        assert!(
            result.maybe_tx.is_some(),
            "Result {} should have transaction",
            i
        );
        assert_eq!(
            result.payloads.len(),
            1,
            "Result {} should have one payload",
            i
        );
    }

    // Verify each transaction has the correct payload
    assert_eq!(results[0].payloads[0].uuid, payload1.details.uuid);
    assert_eq!(results[1].payloads[0].uuid, payload2.details.uuid);
    assert_eq!(results[2].payloads[0].uuid, payload3.details.uuid);
}

#[tokio::test]
async fn test_build_transactions_preserves_success_criteria() {
    let provider = MockTronProvider::new();
    let adapter = create_test_adapter(provider);

    let payload = create_test_payload_with_serialized_criteria();
    let payloads = vec![payload.clone()];

    let results = adapter.build_transactions(&payloads).await;

    assert_eq!(results.len(), 1);
    let tx = results[0].maybe_tx.as_ref().unwrap();

    // Verify success_criteria is preserved in the transaction
    assert!(
        tx.payload_details[0].success_criteria.is_some(),
        "Success criteria should be preserved"
    );
    assert_eq!(
        tx.payload_details[0].success_criteria,
        payload.details.success_criteria
    );
}

#[tokio::test]
async fn test_build_transactions_creates_correct_precursor() {
    let provider = MockTronProvider::new();
    let adapter = create_test_adapter(provider);

    let payload = create_test_payload();
    let payloads = vec![payload];

    let results = adapter.build_transactions(&payloads).await;

    let tx = results[0].maybe_tx.as_ref().unwrap();

    // Verify the precursor is correctly set
    match &tx.vm_specific_data {
        VmSpecificTxData::Tron(precursor) => {
            assert_eq!(precursor.function.name, "testFunction");
        }
        _ => panic!("Expected Tron VmSpecificTxData"),
    }
}

// ============================================================================
// estimate_tx Tests
// ============================================================================

#[tokio::test]
async fn test_estimate_tx_skips_when_gas_already_set() {
    let provider = MockTronProvider::new().with_gas_estimate(U256::from(500_000));
    let adapter = create_test_adapter(provider.clone());

    let mut tx = create_test_transaction();

    // Set gas before estimation
    let precursor = tx.precursor_mut();
    precursor.tx.set_gas(U256::from(200_000));

    let result = adapter.estimate_tx(&mut tx).await;
    assert!(result.is_ok());

    // Verify gas wasn't changed
    assert_eq!(tx.precursor().tx.gas(), Some(&U256::from(200_000)));

    // Verify estimate_gas was NOT called on provider
    let calls = provider.get_calls();
    assert!(
        !calls.contains(&MockCall::EstimateGas),
        "Should not call estimate_gas when gas is already set"
    );
}

#[tokio::test]
async fn test_estimate_tx_sets_gas_when_not_set() {
    let expected_gas = U256::from(150_000);
    let provider = MockTronProvider::new().with_gas_estimate(expected_gas);
    let adapter = create_test_adapter(provider.clone());

    let mut tx = create_test_transaction();

    // Verify gas is initially not set
    assert!(tx.precursor().tx.gas().is_none());

    let result = adapter.estimate_tx(&mut tx).await;
    assert!(result.is_ok());

    // Verify gas was set correctly
    assert_eq!(tx.precursor().tx.gas(), Some(&expected_gas));

    // Verify estimate_gas was called
    let calls = provider.get_calls();
    assert!(
        calls.contains(&MockCall::EstimateGas),
        "Should call estimate_gas when gas is not set"
    );
}

#[tokio::test]
async fn test_estimate_tx_returns_error_on_failure() {
    let provider = MockTronProvider::new().with_estimate_error("Estimation failed");
    let adapter = create_test_adapter(provider);

    let mut tx = create_test_transaction();

    let result = adapter.estimate_tx(&mut tx).await;
    assert!(result.is_err());

    match result {
        Err(LanderError::EstimationFailed) => {}
        Err(e) => panic!("Expected EstimationFailed, got: {:?}", e),
        Ok(_) => panic!("Expected error"),
    }
}

#[tokio::test]
async fn test_estimate_tx_preserves_other_tx_fields() {
    let provider = MockTronProvider::new().with_gas_estimate(U256::from(100_000));
    let adapter = create_test_adapter(provider);

    let mut tx = create_test_transaction();
    let original_uuid = tx.uuid.clone();
    let original_status = tx.status.clone();
    let original_payloads = tx.payload_details.clone();

    adapter.estimate_tx(&mut tx).await.unwrap();

    // Verify other fields weren't modified
    assert_eq!(tx.uuid, original_uuid);
    assert_eq!(tx.status, original_status);
    assert_eq!(tx.payload_details, original_payloads);
}

// ============================================================================
// get_tx_hash_status Tests
// ============================================================================

#[tokio::test]
async fn test_get_tx_hash_status_not_found() {
    let hash = H512::random();
    let provider = MockTronProvider::new(); // No receipt configured -> returns None
    let adapter = create_test_adapter(provider);

    let result = adapter.get_tx_hash_status(hash).await;
    assert!(result.is_err());

    match result {
        Err(LanderError::TxHashNotFound(msg)) => {
            assert!(msg.contains("Transaction not found"));
        }
        Err(e) => panic!("Expected TxHashNotFound, got: {:?}", e),
        Ok(_) => panic!("Expected error"),
    }
}

#[tokio::test]
async fn test_get_tx_hash_status_mempool() {
    let hash = H512::random();
    // Receipt without block number means it's in mempool
    let receipt = create_receipt_with_block(None);
    let provider = MockTronProvider::new().with_receipt(hash, Some(receipt));
    let adapter = create_test_adapter(provider);

    let result = adapter.get_tx_hash_status(hash).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), TransactionStatus::Mempool);
}

#[tokio::test]
async fn test_get_tx_hash_status_included() {
    let hash = H512::random();
    // Receipt with block number 150, finalized block is 100 -> included but not finalized
    let receipt = create_receipt_with_block(Some(150));
    let provider = MockTronProvider::new()
        .with_receipt(hash, Some(receipt))
        .with_finalized_block(100);
    let adapter = create_test_adapter(provider);

    let result = adapter.get_tx_hash_status(hash).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), TransactionStatus::Included);
}

#[tokio::test]
async fn test_get_tx_hash_status_finalized() {
    let hash = H512::random();
    // Receipt with block number 50, finalized block is 100 -> finalized
    let receipt = create_receipt_with_block(Some(50));
    let provider = MockTronProvider::new()
        .with_receipt(hash, Some(receipt))
        .with_finalized_block(100);
    let adapter = create_test_adapter(provider);

    let result = adapter.get_tx_hash_status(hash).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), TransactionStatus::Finalized);
}

#[tokio::test]
async fn test_get_tx_hash_status_finalized_at_exact_block() {
    let hash = H512::random();
    // Receipt with block number 100, finalized block is 100 -> finalized (boundary case)
    let receipt = create_receipt_with_block(Some(100));
    let provider = MockTronProvider::new()
        .with_receipt(hash, Some(receipt))
        .with_finalized_block(100);
    let adapter = create_test_adapter(provider);

    let result = adapter.get_tx_hash_status(hash).await;
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), TransactionStatus::Finalized);
}

#[tokio::test]
async fn test_get_tx_hash_status_finalized_block_error_falls_back_to_mempool() {
    let hash = H512::random();
    // Receipt with block number, but finalized block check fails
    let receipt = create_receipt_with_block(Some(50));
    let provider = MockTronProvider::new()
        .with_receipt(hash, Some(receipt))
        .with_finalized_block_error("RPC error");
    let adapter = create_test_adapter(provider);

    let result = adapter.get_tx_hash_status(hash).await;
    // Should still succeed but return Mempool as fallback
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), TransactionStatus::Mempool);
}

// ============================================================================
// reverted_payloads Tests
// ============================================================================

#[tokio::test]
async fn test_reverted_payloads_no_criteria_returns_empty() {
    let provider = MockTronProvider::new();
    let adapter = create_test_adapter(provider.clone());

    // Transaction without success criteria
    let tx = create_test_transaction();

    let result = adapter.reverted_payloads(&tx).await;
    assert!(result.is_ok());
    assert!(
        result.unwrap().is_empty(),
        "No payloads should be reverted when no success criteria is set"
    );

    // Call should not have been made since no success criteria
    let calls = provider.get_calls();
    assert!(
        !calls.contains(&MockCall::Call),
        "Should not call provider when no success criteria"
    );
}

#[tokio::test]
async fn test_reverted_payloads_success_criteria_passes() {
    let provider = MockTronProvider::new().with_call_result(true);
    let adapter = create_test_adapter(provider.clone());

    let tx = create_test_transaction_with_criteria();

    let result = adapter.reverted_payloads(&tx).await;
    assert!(result.is_ok());
    assert!(
        result.unwrap().is_empty(),
        "No payloads should be reverted when success criteria passes"
    );

    // Verify call was made
    let calls = provider.get_calls();
    assert!(
        calls.contains(&MockCall::Call),
        "Should call provider to check success criteria"
    );
}

#[tokio::test]
async fn test_reverted_payloads_success_criteria_fails() {
    let provider = MockTronProvider::new().with_call_result(false);
    let adapter = create_test_adapter(provider);

    let tx = create_test_transaction_with_criteria();
    let expected_uuid = tx.payload_details[0].uuid.clone();

    let result = adapter.reverted_payloads(&tx).await;
    assert!(result.is_ok());

    let reverted = result.unwrap();
    assert_eq!(reverted.len(), 1, "One payload should be reverted");
    assert_eq!(reverted[0].uuid, expected_uuid);
}

#[tokio::test]
async fn test_reverted_payloads_call_error_propagates() {
    let provider = MockTronProvider::new().with_call_error("RPC error");
    let adapter = create_test_adapter(provider);

    let tx = create_test_transaction_with_criteria();

    let result = adapter.reverted_payloads(&tx).await;
    assert!(result.is_err(), "Error should propagate");
}

// ============================================================================
// Other Adapter Tests
// ============================================================================

#[tokio::test]
async fn test_simulate_tx_returns_empty() {
    let provider = MockTronProvider::new();
    let adapter = create_test_adapter(provider);

    let mut tx = create_test_transaction();
    let result = adapter.simulate_tx(&mut tx).await;

    // Tron doesn't support per-payload simulation yet
    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

#[tokio::test]
async fn test_tx_ready_for_resubmission_always_true() {
    let provider = MockTronProvider::new();
    let adapter = create_test_adapter(provider);

    let tx = create_test_transaction();
    let result = adapter.tx_ready_for_resubmission(&tx).await;

    assert!(result, "Tron should always be ready for resubmission");
}

#[tokio::test]
async fn test_estimated_block_time() {
    let provider = MockTronProvider::new();
    let adapter = create_test_adapter(provider);

    let block_time = adapter.estimated_block_time();
    assert_eq!(*block_time, Duration::from_secs(3));
}
