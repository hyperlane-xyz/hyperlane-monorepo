use solana_sdk::{account::Account, pubkey::Pubkey};

use hyperlane_core::identifiers::UniqueIdentifier;
use uuid::Uuid;

use crate::{
    adapter::chains::sealevel::SealevelTxPrecursor,
    adapter::{chains::sealevel::payload::processed_account, AdaptsChain},
    payload::PayloadDetails,
    transaction::{Transaction, TransactionStatus, VmSpecificTxData},
};

use super::tests_common::{adapter_with_mock_svm_provider, estimate, instruction, MockSvmProvider};
use mockall::predicate::eq;

fn create_test_pubkey() -> Pubkey {
    Pubkey::new_unique()
}

fn create_basic_mock_provider() -> MockSvmProvider {
    // Create a mock provider with basic expectations that don't interfere with simple tests
    MockSvmProvider::new()
}

fn create_payload_details_with_success_criteria(
    success_criteria: Option<Vec<u8>>,
) -> PayloadDetails {
    PayloadDetails::new(
        UniqueIdentifier::new(Uuid::new_v4()),
        "test_payload".to_string(),
        success_criteria,
    )
}

fn create_transaction_with_payload_details(payload_details: Vec<PayloadDetails>) -> Transaction {
    Transaction {
        uuid: UniqueIdentifier::new(Uuid::new_v4()),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::Svm(SealevelTxPrecursor::new(
            instruction(),
            estimate(),
        )),
        payload_details,
        status: TransactionStatus::Finalized,
        submission_attempts: 1,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
        last_status_check: None,
    }
}

// Test helper functions for processed_account extraction
#[test]
fn test_processed_account_none_success_criteria() {
    let payload = create_payload_details_with_success_criteria(None);
    let result = processed_account(&payload);
    assert!(result.is_none());
}

#[test]
fn test_processed_account_valid_pubkey() {
    let test_pubkey = create_test_pubkey();
    let pubkey_bytes = serde_json::to_vec(&test_pubkey).unwrap();
    let payload = create_payload_details_with_success_criteria(Some(pubkey_bytes));

    let result = processed_account(&payload);
    assert!(result.is_some());
    assert_eq!(result.unwrap(), test_pubkey);
}

#[test]
#[should_panic(expected = "Payload should contain a serialised Pubkey")]
fn test_processed_account_invalid_pubkey() {
    let invalid_data = vec![1, 2, 3]; // Not a valid pubkey serialization
    let payload = create_payload_details_with_success_criteria(Some(invalid_data));
    processed_account(&payload);
}

// Basic tests that don't require mocking the provider
#[tokio::test]
async fn test_reverted_payloads_empty_transaction() {
    // given: transaction with no payload details
    let mock_provider = create_basic_mock_provider();
    let adapter = adapter_with_mock_svm_provider(mock_provider);
    let transaction = create_transaction_with_payload_details(vec![]);

    // when
    let result = adapter.reverted_payloads(&transaction).await;

    // then: should return empty vec
    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

#[tokio::test]
async fn test_reverted_payloads_no_success_criteria() {
    // given: payload details without success criteria
    let mock_provider = create_basic_mock_provider();
    let adapter = adapter_with_mock_svm_provider(mock_provider);
    let payload_details = vec![create_payload_details_with_success_criteria(None)];
    let transaction = create_transaction_with_payload_details(payload_details);

    // when
    let result = adapter.reverted_payloads(&transaction).await;

    // then: should return empty vec (filtered out by processed_account)
    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

// Integration tests with proper mocking
#[tokio::test]
async fn test_reverted_payloads_account_exists() {
    // given: payload with valid success criteria and account exists
    let mut mock_provider = MockSvmProvider::new();
    let test_pubkey = create_test_pubkey();
    let pubkey_bytes = serde_json::to_vec(&test_pubkey).unwrap();

    let payload_details = vec![create_payload_details_with_success_criteria(Some(
        pubkey_bytes,
    ))];
    let transaction = create_transaction_with_payload_details(payload_details);

    // Mock provider to return an existing account
    let test_account = Account {
        lamports: 100,
        data: vec![1, 2, 3],
        owner: Pubkey::new_unique(),
        executable: false,
        rent_epoch: 0,
    };
    mock_provider
        .expect_get_account()
        .with(eq(test_pubkey))
        .times(1)
        .returning(move |_| Ok(Some(test_account.clone())));

    let adapter = adapter_with_mock_svm_provider(mock_provider);

    // when
    let result = adapter.reverted_payloads(&transaction).await;

    // then: should return empty vec (the account exists, so not reverted)
    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}

#[tokio::test]
async fn test_reverted_payloads_account_not_exists() {
    // given: payload with valid success criteria but account doesn't exist
    let mut mock_provider = MockSvmProvider::new();
    let test_pubkey = create_test_pubkey();
    let pubkey_bytes = serde_json::to_vec(&test_pubkey).unwrap();

    let payload_details = vec![create_payload_details_with_success_criteria(Some(
        pubkey_bytes,
    ))];
    let transaction = create_transaction_with_payload_details(payload_details.clone());

    // Mock provider to return None (account doesn't exist)
    mock_provider
        .expect_get_account()
        .with(eq(test_pubkey))
        .times(1)
        .returning(|_| Ok(None));

    let adapter = adapter_with_mock_svm_provider(mock_provider);

    // when
    let result = adapter.reverted_payloads(&transaction).await;

    // then: should return the payload detail (account doesn't exist, so reverted)
    assert!(result.is_ok());
    let reverted = result.unwrap();
    assert_eq!(reverted.len(), 1);
    assert_eq!(reverted[0], payload_details[0]);
}

#[tokio::test]
async fn test_reverted_payloads_multiple_mixed() {
    // given: multiple payloads with mixed results
    let mut mock_provider = MockSvmProvider::new();

    let existing_pubkey = create_test_pubkey();
    let missing_pubkey = create_test_pubkey();
    let no_criteria_payload = create_payload_details_with_success_criteria(None);
    let existing_payload = create_payload_details_with_success_criteria(Some(
        serde_json::to_vec(&existing_pubkey).unwrap(),
    ));
    let missing_payload = create_payload_details_with_success_criteria(Some(
        serde_json::to_vec(&missing_pubkey).unwrap(),
    ));

    let payload_details = vec![
        no_criteria_payload,
        existing_payload,
        missing_payload.clone(),
    ];
    let transaction = create_transaction_with_payload_details(payload_details);

    // Mock provider responses
    let test_account = Account {
        lamports: 100,
        data: vec![],
        owner: Pubkey::new_unique(),
        executable: false,
        rent_epoch: 0,
    };
    mock_provider
        .expect_get_account()
        .with(eq(existing_pubkey))
        .times(1)
        .returning(move |_| Ok(Some(test_account.clone())));

    mock_provider
        .expect_get_account()
        .with(eq(missing_pubkey))
        .times(1)
        .returning(|_| Ok(None));

    let adapter = adapter_with_mock_svm_provider(mock_provider);

    // when
    let result = adapter.reverted_payloads(&transaction).await;

    // then: should return only the missing payload
    assert!(result.is_ok());
    let reverted = result.unwrap();
    assert_eq!(reverted.len(), 1);
    assert_eq!(reverted[0], missing_payload);
}

#[tokio::test]
async fn test_reverted_payloads_provider_error() {
    // given: payload with valid success criteria but provider returns error
    let mut mock_provider = MockSvmProvider::new();
    let test_pubkey = create_test_pubkey();
    let pubkey_bytes = serde_json::to_vec(&test_pubkey).unwrap();

    let payload_details = vec![create_payload_details_with_success_criteria(Some(
        pubkey_bytes,
    ))];
    let transaction = create_transaction_with_payload_details(payload_details);

    // Mock provider to return error
    mock_provider
        .expect_get_account()
        .with(eq(test_pubkey))
        .times(1)
        .returning(|_| {
            Err(hyperlane_core::ChainCommunicationError::from_other_str(
                "RPC error",
            ))
        });

    let adapter = adapter_with_mock_svm_provider(mock_provider);

    // when
    let result = adapter.reverted_payloads(&transaction).await;

    // then: should propagate the error
    assert!(result.is_err());
}

#[tokio::test]
async fn test_reverted_payloads_all_reverted() {
    // given: multiple payloads, all missing accounts
    let mut mock_provider = MockSvmProvider::new();

    let pubkey1 = create_test_pubkey();
    let pubkey2 = create_test_pubkey();
    let payload1 =
        create_payload_details_with_success_criteria(Some(serde_json::to_vec(&pubkey1).unwrap()));
    let payload2 =
        create_payload_details_with_success_criteria(Some(serde_json::to_vec(&pubkey2).unwrap()));

    let payload_details = vec![payload1.clone(), payload2.clone()];
    let transaction = create_transaction_with_payload_details(payload_details);

    // Mock provider to return None for both accounts
    mock_provider
        .expect_get_account()
        .with(eq(pubkey1))
        .times(1)
        .returning(|_| Ok(None));

    mock_provider
        .expect_get_account()
        .with(eq(pubkey2))
        .times(1)
        .returning(|_| Ok(None));

    let adapter = adapter_with_mock_svm_provider(mock_provider);

    // when
    let result = adapter.reverted_payloads(&transaction).await;

    // then: should return all payloads
    assert!(result.is_ok());
    let reverted = result.unwrap();
    assert_eq!(reverted.len(), 2);
    assert!(reverted.contains(&payload1));
    assert!(reverted.contains(&payload2));
}

#[tokio::test]
async fn test_reverted_payloads_all_successful() {
    // given: multiple payloads, all accounts exist
    let mut mock_provider = MockSvmProvider::new();

    let pubkey1 = create_test_pubkey();
    let pubkey2 = create_test_pubkey();
    let payload1 =
        create_payload_details_with_success_criteria(Some(serde_json::to_vec(&pubkey1).unwrap()));
    let payload2 =
        create_payload_details_with_success_criteria(Some(serde_json::to_vec(&pubkey2).unwrap()));

    let payload_details = vec![payload1, payload2];
    let transaction = create_transaction_with_payload_details(payload_details);

    // Mock provider to return accounts for both
    let test_account = Account {
        lamports: 100,
        data: vec![],
        owner: Pubkey::new_unique(),
        executable: false,
        rent_epoch: 0,
    };
    mock_provider
        .expect_get_account()
        .with(eq(pubkey1))
        .times(1)
        .returning({
            let account = test_account.clone();
            move |_| Ok(Some(account.clone()))
        });

    mock_provider
        .expect_get_account()
        .with(eq(pubkey2))
        .times(1)
        .returning(move |_| Ok(Some(test_account.clone())));

    let adapter = adapter_with_mock_svm_provider(mock_provider);

    // when
    let result = adapter.reverted_payloads(&transaction).await;

    // then: should return empty vec (all successful)
    assert!(result.is_ok());
    assert!(result.unwrap().is_empty());
}
