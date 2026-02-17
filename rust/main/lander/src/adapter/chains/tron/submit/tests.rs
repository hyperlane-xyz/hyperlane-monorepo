use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use ethers::abi::{Detokenize, Function, Param, ParamType, StateMutability};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::{TransactionReceipt, TransactionRequest, U256};

use hyperlane_core::{ChainCommunicationError, ChainResult, H256, H512};
use hyperlane_tron::TronProviderForLander;

use crate::adapter::chains::tron::{Precursor, TronTxPrecursor};
use crate::payload::PayloadDetails;
use crate::transaction::Transaction;
use crate::{LanderError, PayloadUuid};

use super::submit_transaction;

// ============================================================================
// Mock Provider for Submit Tests
// ============================================================================

/// Mock provider that can return configurable errors for testing error classification
#[derive(Clone)]
struct MockProviderWithError {
    error_message: String,
}

impl MockProviderWithError {
    fn new(error_message: impl Into<String>) -> Self {
        Self {
            error_message: error_message.into(),
        }
    }
}

#[async_trait]
impl TronProviderForLander for MockProviderWithError {
    async fn get_transaction_receipt(
        &self,
        _transaction_hash: H512,
    ) -> ChainResult<Option<TransactionReceipt>> {
        Err(ChainCommunicationError::from_other_str(
            "Mock: not implemented",
        ))
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Err(ChainCommunicationError::from_other_str(
            "Mock: not implemented",
        ))
    }

    async fn submit_tx(&self, _tx: &TypedTransaction) -> ChainResult<H256> {
        Err(ChainCommunicationError::from_other_str(&self.error_message))
    }

    async fn estimate_gas(&self, _tx: &TypedTransaction) -> ChainResult<U256> {
        Err(ChainCommunicationError::from_other_str(
            "Mock: not implemented",
        ))
    }

    async fn call<T: Detokenize>(
        &self,
        _tx: &TypedTransaction,
        _function: &Function,
    ) -> ChainResult<T> {
        Err(ChainCommunicationError::from_other_str(
            "Mock: not implemented",
        ))
    }
}

/// Mock provider that succeeds and tracks calls
#[derive(Clone)]
struct MockProvider {
    calls: Arc<Mutex<Vec<String>>>,
    should_fail: bool,
    tx_hash: Arc<Mutex<Option<H256>>>,
}

impl MockProvider {
    fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            should_fail: false,
            tx_hash: Arc::new(Mutex::new(None)),
        }
    }

    fn failing() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            should_fail: true,
            tx_hash: Arc::new(Mutex::new(None)),
        }
    }

    fn with_tx_hash(self, hash: H256) -> Self {
        *self.tx_hash.lock().unwrap() = Some(hash);
        self
    }

    fn get_calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl TronProviderForLander for MockProvider {
    async fn get_transaction_receipt(
        &self,
        _transaction_hash: H512,
    ) -> ChainResult<Option<TransactionReceipt>> {
        self.calls
            .lock()
            .unwrap()
            .push("get_transaction_receipt".to_string());
        Ok(None)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.calls
            .lock()
            .unwrap()
            .push("get_finalized_block_number".to_string());
        Ok(100)
    }

    async fn submit_tx(&self, _tx: &TypedTransaction) -> ChainResult<H256> {
        self.calls.lock().unwrap().push("submit_tx".to_string());

        if self.should_fail {
            return Err(ChainCommunicationError::from_other_str(
                "Mock provider: intentional failure",
            ));
        }

        let hash = self.tx_hash.lock().unwrap().unwrap_or_else(H256::random);
        Ok(hash)
    }

    async fn estimate_gas(&self, _tx: &TypedTransaction) -> ChainResult<U256> {
        self.calls.lock().unwrap().push("estimate_gas".to_string());
        Ok(U256::from(21_000))
    }

    async fn call<T: Detokenize>(
        &self,
        _tx: &TypedTransaction,
        _function: &Function,
    ) -> ChainResult<T> {
        self.calls.lock().unwrap().push("call".to_string());
        Err(ChainCommunicationError::from_other_str(
            "Mock: call not implemented",
        ))
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

// ============================================================================
// Submit Transaction Success Tests
// ============================================================================

#[tokio::test]
async fn test_submit_transaction_success() {
    let provider = MockProvider::new();
    let mut tx = create_test_transaction();

    assert!(
        tx.tx_hashes.is_empty(),
        "Tx hashes should be empty initially"
    );

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_ok(), "Expected successful submission");

    // Verify provider was called
    let calls = provider.get_calls();
    assert!(calls.contains(&"submit_tx".to_string()));

    // Verify transaction hash was stored
    assert_eq!(tx.tx_hashes.len(), 1, "Should have one tx hash");
}

#[tokio::test]
async fn test_submit_transaction_stores_specific_hash() {
    let expected_hash = H256::from_low_u64_be(0xdeadbeef);
    let provider = MockProvider::new().with_tx_hash(expected_hash);
    let mut tx = create_test_transaction();

    submit_transaction(&provider, &mut tx).await.unwrap();

    assert_eq!(tx.tx_hashes.len(), 1);
    // H256 to H512 conversion pads with zeros
    let stored_hash = tx.tx_hashes[0];
    // The stored hash should contain the H256 value
    assert_ne!(stored_hash, H512::zero());
}

#[tokio::test]
async fn test_submit_transaction_does_not_duplicate_hash() {
    let hash = H256::from_low_u64_be(0xbeef);
    let provider = MockProvider::new().with_tx_hash(hash);
    let mut tx = create_test_transaction();

    // Submit twice with same hash
    submit_transaction(&provider, &mut tx).await.unwrap();
    let first_count = tx.tx_hashes.len();

    // Try to submit again - should not duplicate
    submit_transaction(&provider, &mut tx).await.unwrap();
    assert_eq!(
        tx.tx_hashes.len(),
        first_count,
        "Should not duplicate tx hash"
    );
}

#[tokio::test]
async fn test_submit_transaction_preserves_fields() {
    let provider = MockProvider::new();
    let mut tx = create_test_transaction();

    let original_uuid = tx.uuid.clone();
    let original_status = tx.status.clone();
    let original_payloads = tx.payload_details.clone();

    submit_transaction(&provider, &mut tx).await.unwrap();

    assert_eq!(tx.uuid, original_uuid, "UUID should be preserved");
    assert_eq!(tx.status, original_status, "Status should be preserved");
    assert_eq!(
        tx.payload_details, original_payloads,
        "Payloads should be preserved"
    );
}

#[tokio::test]
async fn test_submit_transaction_generic_failure() {
    let provider = MockProvider::failing();
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    // Generic errors should be converted to ChainCommunicationError
    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::ChainCommunicationError(_)),
        "Expected ChainCommunicationError, got: {:?}",
        err
    );

    // No hash should be stored on failure
    assert!(tx.tx_hashes.is_empty());
}

// ============================================================================
// Error Classification Tests - Retryable Errors (TxSubmissionError)
// ============================================================================

#[tokio::test]
async fn test_tron_error_bandwidth_error() {
    let provider = MockProviderWithError::new("BANDWITH_ERROR");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    // BANDWITH_ERROR is also mapped to TxGasCapReached
    assert!(
        matches!(err, LanderError::TxGasCapReached),
        "Expected TxGasCapReached for BANDWITH_ERROR, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_server_busy() {
    let provider = MockProviderWithError::new("SERVER_BUSY");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::TxSubmissionError(_)),
        "Expected TxSubmissionError for SERVER_BUSY, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_not_enough_effective_connection() {
    let provider = MockProviderWithError::new("NOT_ENOUGH_EFFECTIVE_CONNECTION");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::TxSubmissionError(_)),
        "Expected TxSubmissionError for NOT_ENOUGH_EFFECTIVE_CONNECTION, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_other_error() {
    let provider = MockProviderWithError::new("OTHER_ERROR");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::TxSubmissionError(_)),
        "Expected TxSubmissionError for OTHER_ERROR, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_no_connection() {
    let provider = MockProviderWithError::new("NO_CONNECTION");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::TxSubmissionError(_)),
        "Expected TxSubmissionError for NO_CONNECTION, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_block_unsolidified() {
    let provider = MockProviderWithError::new("BLOCK_UNSOLIDIFIED");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::TxSubmissionError(_)),
        "Expected TxSubmissionError for BLOCK_UNSOLIDIFIED, got: {:?}",
        err
    );
}

// ============================================================================
// Error Classification Tests - Duplicate Transaction
// ============================================================================

#[tokio::test]
async fn test_tron_error_dup_transaction() {
    let provider = MockProviderWithError::new("DUP_TRANSACTION_ERROR");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::TxAlreadyExists),
        "Expected TxAlreadyExists for DUP_TRANSACTION_ERROR, got: {:?}",
        err
    );
}

// ============================================================================
// Error Classification Tests - Non-Retryable Errors
// ============================================================================

#[tokio::test]
async fn test_tron_error_sigerror() {
    let provider = MockProviderWithError::new("SIGERROR");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for SIGERROR, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_tapos_error() {
    let provider = MockProviderWithError::new("TAPOS_ERROR");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for TAPOS_ERROR, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_too_big_transaction() {
    let provider = MockProviderWithError::new("TOO_BIG_TRANSACTION_ERROR");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for TOO_BIG_TRANSACTION_ERROR, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_transaction_expiration() {
    let provider = MockProviderWithError::new("TRANSACTION_EXPIRATION_ERROR");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for TRANSACTION_EXPIRATION_ERROR, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_contract_exe_error() {
    let provider = MockProviderWithError::new("CONTRACT_EXE_ERROR");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for CONTRACT_EXE_ERROR, got: {:?}",
        err
    );
}

// ============================================================================
// Error Classification Tests - Unknown/Generic Errors
// ============================================================================

#[tokio::test]
async fn test_tron_error_unknown_becomes_chain_communication_error() {
    let provider = MockProviderWithError::new("SOME_UNKNOWN_ERROR_TYPE");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    // Unknown errors should fall through to ChainCommunicationError
    assert!(
        matches!(err, LanderError::ChainCommunicationError(_)),
        "Expected ChainCommunicationError for unknown error, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_mixed_message() {
    // Error message contains one of the known errors in a longer message
    let provider =
        MockProviderWithError::new("Transaction failed with SIGERROR: invalid signature");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    // Should still match SIGERROR
    assert!(
        matches!(err, LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for message containing SIGERROR, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_dup_transaction_in_context() {
    let provider =
        MockProviderWithError::new("Broadcast failed: DUP_TRANSACTION_ERROR transaction exists");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::TxAlreadyExists),
        "Expected TxAlreadyExists for message containing DUP_TRANSACTION_ERROR, got: {:?}",
        err
    );
}

// ============================================================================
// Error Classification Edge Cases
// ============================================================================

#[tokio::test]
async fn test_tron_error_case_sensitivity() {
    // The error codes are case-sensitive (uppercase)
    let provider = MockProviderWithError::new("sigerror"); // lowercase
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    // Lowercase should NOT match, so it becomes ChainCommunicationError
    assert!(
        matches!(err, LanderError::ChainCommunicationError(_)),
        "Expected ChainCommunicationError for lowercase sigerror, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_empty_message() {
    let provider = MockProviderWithError::new("");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::ChainCommunicationError(_)),
        "Expected ChainCommunicationError for empty message, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_tron_error_whitespace_only() {
    let provider = MockProviderWithError::new("   ");
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, LanderError::ChainCommunicationError(_)),
        "Expected ChainCommunicationError for whitespace message, got: {:?}",
        err
    );
}
