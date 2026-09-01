use crate::adapter::AdaptsChain;
use crate::error::LanderError;
use crate::transaction::TransactionStatus;
use hyperlane_core::{ChainCommunicationError, H512};
use solana_transaction_status::{
    TransactionConfirmationStatus, TransactionStatus as SealevelTransactionStatus,
};

use super::tests_common::{
    adapter, adapter_with_mock_client, signature_status_response, transaction, MockClient,
};

#[tokio::test]
async fn test_tx_status() {
    // given
    let adapter = adapter();
    let transaction = transaction();

    // when
    let result = adapter.tx_status(&transaction).await;

    // then
    assert!(result.is_ok());
    let status = result.unwrap();
    assert!(matches!(status, TransactionStatus::Finalized));
}

#[tokio::test]
async fn signature_status_uses_one_rpc_call() {
    let mut client = MockClient::new();
    client
        .expect_get_signature_statuses_with_history()
        .times(1)
        .returning(|_| Ok(signature_status_response(None)));
    let adapter = adapter_with_mock_client(client);

    let status = adapter.get_tx_hash_status(H512::zero()).await;

    assert!(matches!(status, Err(LanderError::TxHashNotFound(_))));
}

#[tokio::test]
async fn signature_status_provider_error_is_infrastructure_error() {
    let mut client = MockClient::new();
    client
        .expect_get_signature_statuses_with_history()
        .times(1)
        .returning(|_| Err(ChainCommunicationError::from_other_str("RPC unavailable")));
    let adapter = adapter_with_mock_client(client);

    let status = adapter.get_tx_hash_status(H512::zero()).await;

    assert!(matches!(
        status,
        Err(LanderError::ChainCommunicationError(_))
    ));
}

#[test]
fn legacy_confirmation_count_maps_to_lander_status() {
    for (confirmations, expected) in [
        (Some(0), TransactionStatus::Mempool),
        (Some(1), TransactionStatus::Included),
        (None, TransactionStatus::Finalized),
    ] {
        let status = SealevelTransactionStatus {
            slot: 43,
            confirmations,
            status: Ok(()),
            err: None,
            confirmation_status: None,
        };

        assert_eq!(
            super::super::SealevelAdapter::classify_signature_status(status),
            expected
        );
    }
}

#[test]
fn signature_confirmation_status_maps_to_lander_status() {
    for (confirmation_status, expected) in [
        (
            TransactionConfirmationStatus::Processed,
            TransactionStatus::Mempool,
        ),
        (
            TransactionConfirmationStatus::Confirmed,
            TransactionStatus::Included,
        ),
        (
            TransactionConfirmationStatus::Finalized,
            TransactionStatus::Finalized,
        ),
    ] {
        let status = SealevelTransactionStatus {
            slot: 43,
            confirmations: None,
            status: Ok(()),
            err: None,
            confirmation_status: Some(confirmation_status),
        };

        assert_eq!(
            super::super::SealevelAdapter::classify_signature_status(status),
            expected
        );
    }
}
