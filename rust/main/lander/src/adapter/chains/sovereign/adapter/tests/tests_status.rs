use std::sync::Arc;

use hyperlane_core::{ChainCommunicationError, H256};
use hyperlane_sovereign::{Receipt, SequencerTx, Tx, TxData, TxResult};

use crate::adapter::AdaptsChain;
use crate::transaction::TransactionStatus;
use crate::{LanderError, TransactionDropReason};

use super::tests_common::{adapter, h256_to_h512, MockSovereignProvider};

fn make_tx(result: TxResult) -> Tx {
    Tx {
        number: 1,
        hash: H256::zero(),
        events: vec![],
        batch_number: 1,
        receipt: Receipt {
            result,
            data: TxData {
                gas_used: vec![100],
            },
        },
    }
}

#[tokio::test]
async fn get_tx_hash_status_successful() {
    let mut provider = MockSovereignProvider::new();

    provider
        .expect_get_tx_by_hash()
        .returning(|_| Ok(make_tx(TxResult::Successful)));

    let provider_arc = Arc::new(provider);
    let adapter = adapter(provider_arc);

    let hash = h256_to_h512(H256::zero());
    let tx_status = adapter
        .get_tx_hash_status(hash)
        .await
        .expect("Failed to get tx hash status");

    assert_eq!(tx_status, TransactionStatus::Finalized);
}

#[tokio::test]
async fn get_tx_hash_status_reverted() {
    let mut provider = MockSovereignProvider::new();

    provider
        .expect_get_tx_by_hash()
        .returning(|_| Ok(make_tx(TxResult::Reverted)));

    let provider_arc = Arc::new(provider);
    let adapter = adapter(provider_arc);

    let hash = h256_to_h512(H256::zero());
    let tx_status = adapter
        .get_tx_hash_status(hash)
        .await
        .expect("Failed to get tx hash status");

    assert_eq!(
        tx_status,
        TransactionStatus::Dropped(TransactionDropReason::DroppedByChain)
    );
}

#[tokio::test]
async fn get_tx_hash_status_skipped() {
    let mut provider = MockSovereignProvider::new();

    provider
        .expect_get_tx_by_hash()
        .returning(|_| Ok(make_tx(TxResult::Skipped)));

    let provider_arc = Arc::new(provider);
    let adapter = adapter(provider_arc);

    let hash = h256_to_h512(H256::zero());
    let tx_status = adapter
        .get_tx_hash_status(hash)
        .await
        .expect("Failed to get tx hash status");

    assert_eq!(
        tx_status,
        TransactionStatus::Dropped(TransactionDropReason::DroppedByChain)
    );
}

#[tokio::test]
async fn get_tx_hash_status_not_found() {
    let mut provider = MockSovereignProvider::new();

    // Ledger returns 404
    provider.expect_get_tx_by_hash().returning(|_| {
        Err(ChainCommunicationError::CustomError(
            "Transaction not found".to_string(),
        ))
    });

    // Sequencer also returns 404
    provider.expect_get_tx_from_sequencer().returning(|_| {
        Err(ChainCommunicationError::CustomError(
            "Transaction not found".to_string(),
        ))
    });

    let provider_arc = Arc::new(provider);
    let adapter = adapter(provider_arc);

    let hash = h256_to_h512(H256::zero());
    let tx_status = adapter.get_tx_hash_status(hash).await;

    match tx_status {
        Err(LanderError::TxHashNotFound(_)) => {}
        val => panic!("Expected TxHashNotFound, got {val:?}"),
    }
}

#[tokio::test]
async fn get_tx_hash_status_soft_confirmed() {
    let mut provider = MockSovereignProvider::new();
    let tx_hash = H256::random();

    // Ledger returns 404 (not processed yet)
    provider.expect_get_tx_by_hash().returning(|_| {
        Err(ChainCommunicationError::CustomError(
            "Transaction not found".to_string(),
        ))
    });

    // Sequencer returns the tx (soft confirmed)
    provider.expect_get_tx_from_sequencer().returning(move |_| {
        Ok(SequencerTx {
            id: tx_hash,
            tx_number: 42,
        })
    });

    let provider_arc = Arc::new(provider);
    let adapter = adapter(provider_arc);

    let hash = h256_to_h512(tx_hash);
    let tx_status = adapter
        .get_tx_hash_status(hash)
        .await
        .expect("Failed to get tx hash status");

    // Soft confirmed should return Included so we wait for finalization
    assert_eq!(tx_status, TransactionStatus::Included);
}
