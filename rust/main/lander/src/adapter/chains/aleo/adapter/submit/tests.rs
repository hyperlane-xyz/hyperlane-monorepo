use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use hyperlane_aleo::{
    AleoConfirmedTransaction, AleoProviderForLander, AleoUnconfirmedTransaction, CurrentNetwork,
};
use hyperlane_core::{ChainResult, H512};

use crate::adapter::chains::AleoTxPrecursor;
use crate::payload::PayloadDetails;
use crate::transaction::Transaction;
use crate::{PayloadUuid, TransactionUuid};

use super::super::super::transaction::Precursor;
use super::submit_transaction;

/// Mock provider that tracks calls and returns configurable results
#[derive(Clone)]
struct MockProvider {
    calls: Arc<Mutex<Vec<MockCall>>>,
    should_fail: bool,
}

#[derive(Debug, Clone)]
struct MockCall {
    program_id: String,
    function_name: String,
    inputs: Vec<String>,
}

impl MockProvider {
    fn new() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            should_fail: false,
        }
    }

    fn failing() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            should_fail: true,
        }
    }

    fn get_calls(&self) -> Vec<MockCall> {
        self.calls.lock().unwrap().clone()
    }
}

/// Mock provider that returns specific error messages for testing error classification
#[derive(Clone)]
struct MockProviderWithError {
    error_message: String,
}

impl MockProviderWithError {
    fn new(error_message: String) -> Self {
        Self { error_message }
    }
}

#[async_trait]
impl AleoProviderForLander for MockProviderWithError {
    async fn submit_tx<I>(
        &self,
        _program_id: &str,
        _function_name: &str,
        _input: I,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = String> + Send,
        I::IntoIter: ExactSizeIterator,
    {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            &self.error_message,
        ))
    }

    async fn get_confirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoConfirmedTransaction<CurrentNetwork>> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "Mock provider: get_confirmed_transaction not implemented",
        ))
    }

    async fn get_unconfirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoUnconfirmedTransaction<CurrentNetwork>> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "Mock provider: get_unconfirmed_transaction not implemented",
        ))
    }
}

#[async_trait]
impl AleoProviderForLander for MockProvider {
    async fn submit_tx<I>(
        &self,
        program_id: &str,
        function_name: &str,
        input: I,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = String> + Send,
        I::IntoIter: ExactSizeIterator,
    {
        let inputs: Vec<String> = input.into_iter().collect();

        // Record the call
        self.calls.lock().unwrap().push(MockCall {
            program_id: program_id.to_string(),
            function_name: function_name.to_string(),
            inputs: inputs.clone(),
        });

        if self.should_fail {
            return Err(hyperlane_core::ChainCommunicationError::from_other_str(
                "Mock provider: intentional failure",
            ));
        }

        Ok(H512::random())
    }

    async fn get_confirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoConfirmedTransaction<CurrentNetwork>> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "Mock provider: get_confirmed_transaction not implemented",
        ))
    }

    async fn get_unconfirmed_transaction(
        &self,
        _transaction_id: H512,
    ) -> ChainResult<AleoUnconfirmedTransaction<CurrentNetwork>> {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "Mock provider: get_unconfirmed_transaction not implemented",
        ))
    }
}

fn create_test_transaction() -> Transaction {
    let precursor = AleoTxPrecursor {
        program_id: "test_program.aleo".to_string(),
        function_name: "test_function".to_string(),
        inputs: vec!["input1".to_string(), "input2".to_string()],
    };

    let payload_uuid = PayloadUuid::random();

    let payload_details = PayloadDetails {
        uuid: payload_uuid,
        metadata: "test-payload".to_string(),
        success_criteria: Some(vec![1, 2, 3]),
    };

    Transaction::new(precursor, vec![payload_details])
}

#[tokio::test]
async fn test_submit_transaction_success() {
    let provider = MockProvider::new();
    let mut tx = create_test_transaction();

    assert!(tx.tx_hashes.is_empty());

    // Submit transaction
    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_ok(), "Expected successful submission");

    // Verify provider was called correctly
    let calls = provider.get_calls();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!(call.program_id, "test_program.aleo");
    assert_eq!(call.function_name, "test_function");
    assert_eq!(call.inputs, vec!["input1", "input2"]);

    // Verify transaction hash was stored
    assert_eq!(tx.tx_hashes.len(), 1);
}

#[tokio::test]
async fn test_submit_transaction_stores_tx_hash() {
    let provider = MockProvider::new();
    let mut tx = create_test_transaction();

    assert!(tx.tx_hashes.is_empty());

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_ok());

    // Verify transaction hash was added
    assert_eq!(tx.tx_hashes.len(), 1);
    assert_ne!(tx.tx_hashes[0], H512::zero());
}

#[tokio::test]
async fn test_submit_transaction_provider_failure() {
    let provider = MockProvider::failing();
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;

    // Verify submission failed
    assert!(result.is_err());
    let err = result.unwrap_err();

    // Generic errors are converted to ChainCommunicationError
    assert!(matches!(
        err,
        crate::LanderError::ChainCommunicationError(_)
    ));

    // Verify error message contains expected text
    let err_str = err.to_string();
    assert!(err_str.contains("Mock provider: intentional failure"));

    // Verify no transaction hash was added on failure
    assert!(tx.tx_hashes.is_empty());
}

#[tokio::test]
async fn test_submit_transaction_preserves_transaction_fields() {
    let provider = MockProvider::new();
    let mut tx = create_test_transaction();

    let original_uuid = tx.uuid.clone();
    let original_status = tx.status.clone();
    let original_payload_details = tx.payload_details.clone();

    submit_transaction(&provider, &mut tx).await.unwrap();

    // Verify original fields are preserved
    assert_eq!(tx.uuid, original_uuid);
    assert_eq!(tx.status, original_status);
    assert_eq!(tx.payload_details, original_payload_details);
}

#[tokio::test]
async fn test_submit_transaction_with_empty_inputs() {
    let provider = MockProvider::new();
    let mut tx = create_test_transaction();

    // Clear inputs
    let precursor = tx.precursor_mut();
    precursor.inputs.clear();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_ok());

    // Verify provider was called with empty inputs
    let calls = provider.get_calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].inputs.is_empty());
}

#[tokio::test]
async fn test_submit_transaction_with_many_inputs() {
    let provider = MockProvider::new();
    let mut tx = create_test_transaction();

    // Add many inputs
    let precursor = tx.precursor_mut();
    precursor.inputs = (0..100).map(|i| format!("input{}", i)).collect();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_ok());

    // Verify provider was called with all inputs
    let calls = provider.get_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].inputs.len(), 100);
}

#[tokio::test]
async fn test_submit_transaction_mutates_only_expected_fields() {
    let provider = MockProvider::new();
    let mut tx = create_test_transaction();

    let original_uuid = tx.uuid.clone();
    let original_status = tx.status.clone();
    let original_payload_details = tx.payload_details.clone();
    let original_program_id = tx.precursor().program_id.clone();
    let original_function_name = tx.precursor().function_name.clone();
    let original_inputs = tx.precursor().inputs.clone();

    submit_transaction(&provider, &mut tx).await.unwrap();

    // Verify immutable fields remain unchanged
    assert_eq!(tx.uuid, original_uuid);
    assert_eq!(tx.status, original_status);
    assert_eq!(tx.payload_details, original_payload_details);
    assert_eq!(tx.precursor().program_id, original_program_id);
    assert_eq!(tx.precursor().function_name, original_function_name);
    assert_eq!(tx.precursor().inputs, original_inputs);

    // Verify only expected fields were mutated
    assert!(!tx.tx_hashes.is_empty()); // Hash was added
}

// Aleo-specific error classification tests
// Based on: https://gist.github.com/iamalwaysuncomfortable/d79660cd609be50866fef16b05cbcde2

#[tokio::test]
async fn test_aleo_error_too_many_requests() {
    let provider = MockProviderWithError::new("Too many requests".to_string());
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, crate::LanderError::TxSubmissionError(_)),
        "Expected TxSubmissionError for rate limiting, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_aleo_error_too_many_execution_verifications() {
    let provider =
        MockProviderWithError::new("Too many execution verifications in progress".to_string());
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, crate::LanderError::TxSubmissionError(_)),
        "Expected TxSubmissionError for node overload, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_aleo_error_too_many_deploy_verifications() {
    let provider =
        MockProviderWithError::new("Too many deploy verifications in progress".to_string());
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, crate::LanderError::TxSubmissionError(_)),
        "Expected TxSubmissionError for node overload, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_aleo_error_node_syncing() {
    let provider =
        MockProviderWithError::new("Unable to validate transaction (node is syncing)".to_string());
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, crate::LanderError::TxSubmissionError(_)),
        "Expected TxSubmissionError for node syncing, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_aleo_error_transaction_already_exists() {
    let provider = MockProviderWithError::new(
        "Transaction 'at1xyz...' already exists in the ledger".to_string(),
    );
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, crate::LanderError::TxAlreadyExists),
        "Expected TxAlreadyExists for duplicate transaction, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_aleo_error_duplicate_input() {
    let provider = MockProviderWithError::new("Found a duplicate Input ID: 1234567890".to_string());
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, crate::LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for duplicate input (spent by another tx), got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_aleo_error_transaction_size_exceeded() {
    let provider =
        MockProviderWithError::new("Transaction size exceeds the byte limit".to_string());
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, crate::LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for size limit, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_aleo_error_invalid_transaction_data() {
    let provider = MockProviderWithError::new("Invalid Transaction Data".to_string());
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, crate::LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for invalid data, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_aleo_error_not_well_formed() {
    let provider = MockProviderWithError::new(
        "Transaction 'at1xyz...' is not well-formed: size violation".to_string(),
    );
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, crate::LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for malformed transaction, got: {:?}",
        err
    );
}

#[tokio::test]
async fn test_aleo_error_incorrect_transaction_id() {
    let provider = MockProviderWithError::new(
        "Incorrect transaction ID (at1abc123...) - possible modification".to_string(),
    );
    let mut tx = create_test_transaction();

    let result = submit_transaction(&provider, &mut tx).await;
    assert!(result.is_err());

    let err = result.unwrap_err();
    assert!(
        matches!(err, crate::LanderError::NonRetryableError(_)),
        "Expected NonRetryableError for incorrect tx ID, got: {:?}",
        err
    );
}
