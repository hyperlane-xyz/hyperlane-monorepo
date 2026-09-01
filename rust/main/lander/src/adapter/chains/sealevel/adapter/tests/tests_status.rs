use crate::adapter::AdaptsChain;
use crate::error::LanderError;
use crate::transaction::{Transaction, TransactionStatus};
use hyperlane_core::{ChainCommunicationError, H512};
use mockall::Sequence;
use solana_transaction_status::{
    TransactionConfirmationStatus, TransactionStatus as SealevelTransactionStatus,
};

use super::tests_common::{
    adapter, adapter_with_mock_client, finalized_signature_status, signature_status_response,
    signature_statuses_response, transaction, MockClient,
};

fn hash(index: u64) -> H512 {
    let mut bytes = [0u8; 64];
    bytes[..8].copy_from_slice(&index.to_be_bytes());
    H512::from(bytes)
}

fn transaction_with_hashes(hashes: impl IntoIterator<Item = H512>) -> Transaction {
    let mut tx = transaction();
    tx.tx_hashes = hashes.into_iter().collect();
    tx
}

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

#[tokio::test]
async fn transaction_statuses_share_one_rpc_batch() {
    let mut client = MockClient::new();
    client
        .expect_get_signature_statuses_with_history()
        .withf(|signatures| signatures.len() == 3)
        .times(1)
        .returning(|_| {
            let mut confirmed = finalized_signature_status();
            confirmed.confirmation_status = Some(TransactionConfirmationStatus::Confirmed);
            Ok(signature_statuses_response(vec![
                Some(finalized_signature_status()),
                Some(confirmed),
                None,
            ]))
        });
    let adapter = adapter_with_mock_client(client);
    let transactions = vec![transaction(), transaction(), transaction()];

    let statuses = adapter.tx_statuses(&transactions).await;

    assert_eq!(statuses.len(), transactions.len());
    assert_eq!(statuses[0].as_ref().unwrap(), &TransactionStatus::Finalized);
    assert_eq!(statuses[1].as_ref().unwrap(), &TransactionStatus::Included);
    assert_eq!(
        statuses[2].as_ref().unwrap(),
        &TransactionStatus::PendingInclusion
    );
    assert_eq!(adapter.tx_status_batch_size(), 16);
}

#[tokio::test]
async fn transaction_statuses_align_mixed_multi_hash_results() {
    let mut client = MockClient::new();
    client
        .expect_get_signature_statuses_with_history()
        .withf(|signatures| signatures.len() == 4)
        .times(1)
        .returning(|_| {
            let mut confirmed = finalized_signature_status();
            confirmed.confirmation_status = Some(TransactionConfirmationStatus::Confirmed);
            let mut processed = finalized_signature_status();
            processed.confirmation_status = Some(TransactionConfirmationStatus::Processed);
            Ok(signature_statuses_response(vec![
                None,
                Some(confirmed),
                Some(processed),
                Some(finalized_signature_status()),
            ]))
        });
    let adapter = adapter_with_mock_client(client);
    let transactions = vec![
        transaction_with_hashes([hash(1), hash(2)]),
        transaction_with_hashes([hash(3), hash(4)]),
        transaction_with_hashes([]),
    ];

    let statuses = adapter.tx_statuses(&transactions).await;

    assert_eq!(statuses.len(), transactions.len());
    assert_eq!(statuses[0].as_ref().unwrap(), &TransactionStatus::Included);
    assert_eq!(statuses[1].as_ref().unwrap(), &TransactionStatus::Finalized);
    assert_eq!(
        statuses[2].as_ref().unwrap(),
        &TransactionStatus::PendingInclusion
    );
}

#[tokio::test]
async fn transaction_statuses_split_at_256_signatures() {
    let mut client = MockClient::new();
    let mut sequence = Sequence::new();
    client
        .expect_get_signature_statuses_with_history()
        .withf(|signatures| signatures.len() == 256)
        .times(1)
        .in_sequence(&mut sequence)
        .returning(|_| Ok(signature_statuses_response(vec![None; 256])));
    client
        .expect_get_signature_statuses_with_history()
        .withf(|signatures| signatures.len() == 1)
        .times(1)
        .in_sequence(&mut sequence)
        .returning(|_| {
            Ok(signature_statuses_response(vec![Some(
                finalized_signature_status(),
            )]))
        });
    let adapter = adapter_with_mock_client(client);
    let transaction = transaction_with_hashes((0..257).map(hash));

    let statuses = adapter.tx_statuses(&[transaction]).await;

    assert_eq!(statuses.len(), 1);
    assert_eq!(statuses[0].as_ref().unwrap(), &TransactionStatus::Finalized);
}

#[tokio::test]
async fn transaction_statuses_surface_partial_rpc_failure() {
    let mut client = MockClient::new();
    let mut sequence = Sequence::new();
    client
        .expect_get_signature_statuses_with_history()
        .withf(|signatures| signatures.len() == 256)
        .times(1)
        .in_sequence(&mut sequence)
        .returning(|_| {
            let mut confirmed = finalized_signature_status();
            confirmed.confirmation_status = Some(TransactionConfirmationStatus::Confirmed);
            Ok(signature_statuses_response(vec![Some(confirmed); 256]))
        });
    client
        .expect_get_signature_statuses_with_history()
        .withf(|signatures| signatures.len() == 1)
        .times(1)
        .in_sequence(&mut sequence)
        .returning(|_| Err(ChainCommunicationError::from_other_str("RPC unavailable")));
    let adapter = adapter_with_mock_client(client);
    let transactions = vec![
        transaction_with_hashes((0..256).map(hash)),
        transaction_with_hashes([hash(256)]),
    ];

    let statuses = adapter.tx_statuses(&transactions).await;

    assert_eq!(statuses[0].as_ref().unwrap(), &TransactionStatus::Included);
    assert!(matches!(statuses[1], Err(LanderError::NetworkError(_))));
}

#[tokio::test]
async fn transaction_statuses_reject_short_response() {
    let mut client = MockClient::new();
    client
        .expect_get_signature_statuses_with_history()
        .withf(|signatures| signatures.len() == 2)
        .times(1)
        .returning(|_| Ok(signature_status_response(None)));
    let adapter = adapter_with_mock_client(client);
    let transactions = vec![
        transaction_with_hashes([hash(1)]),
        transaction_with_hashes([hash(2)]),
    ];

    let statuses = adapter.tx_statuses(&transactions).await;

    assert!(statuses
        .iter()
        .all(|status| matches!(status, Err(LanderError::NetworkError(_)))));
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
