use std::sync::Arc;

use ethers::utils::hex;
use gateway_api_client::models::{TransactionStatusResponse, TransactionSubmitResponse};
use radix_common::crypto::Ed25519PrivateKey;

use hyperlane_core::{ChainResult, H512};
use hyperlane_radix::RadixSigner;
use scrypto::network::NetworkDefinition;

use crate::adapter::AdaptsChain;
use crate::transaction::TransactionStatus;
use crate::{
    adapter::chains::radix::adapter::tests::tests_common::{MockRadixProvider, TEST_PRIVATE_KEY},
    LanderError, TransactionDropReason,
};

use super::tests_common::adapter;

#[tokio::test]
async fn get_tx_hash_status_pending() {
    let mut provider = MockRadixProvider::new();

    provider.expect_get_tx_hash_status().returning(|_| {
        Ok(TransactionStatusResponse {
            status: gateway_api_client::models::TransactionStatus::Pending,
            ..Default::default()
        })
    });

    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let provider_arc = Arc::new(provider);
    let network = NetworkDefinition::mainnet();
    let adapter = adapter(&network, provider_arc.clone(), signer.clone());

    let hash = H512::zero();
    let tx_status = adapter
        .get_tx_hash_status(hash)
        .await
        .expect("Failed to get tx hash status");

    assert_eq!(tx_status, TransactionStatus::Mempool);
}

#[tokio::test]
async fn get_tx_hash_status_rejected() {
    let mut provider = MockRadixProvider::new();

    provider.expect_get_tx_hash_status().returning(|_| {
        Ok(TransactionStatusResponse {
            status: gateway_api_client::models::TransactionStatus::Rejected,
            ..Default::default()
        })
    });

    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let provider_arc = Arc::new(provider);
    let network = NetworkDefinition::mainnet();
    let adapter = adapter(&network, provider_arc.clone(), signer.clone());

    let hash = H512::zero();
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
async fn get_tx_hash_status_unknown() {
    let mut provider = MockRadixProvider::new();

    provider.expect_get_tx_hash_status().returning(|_| {
        Ok(TransactionStatusResponse {
            status: gateway_api_client::models::TransactionStatus::Unknown,
            ..Default::default()
        })
    });

    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let provider_arc = Arc::new(provider);
    let network = NetworkDefinition::mainnet();
    let adapter = adapter(&network, provider_arc.clone(), signer.clone());

    let hash = H512::zero();
    let tx_status = adapter.get_tx_hash_status(hash).await;

    match tx_status {
        Err(LanderError::TxHashNotFound(tx_hash)) => {
            assert_eq!(tx_hash, format!("{hash:x}"));
        }
        val => {
            panic!("Incorrect status {val:?}");
        }
    }
}

#[tokio::test]
async fn get_tx_hash_status_committed_failure() {
    let mut provider = MockRadixProvider::new();

    provider.expect_get_tx_hash_status().returning(|_| {
        Ok(TransactionStatusResponse {
            status: gateway_api_client::models::TransactionStatus::CommittedFailure,
            ..Default::default()
        })
    });

    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let provider_arc = Arc::new(provider);
    let network = NetworkDefinition::mainnet();
    let adapter = adapter(&network, provider_arc.clone(), signer.clone());

    let hash = H512::zero();
    let tx_status = adapter
        .get_tx_hash_status(hash)
        .await
        .expect("Failed to get tx hash status");

    assert_eq!(
        tx_status,
        TransactionStatus::Dropped(TransactionDropReason::FailedSimulation)
    );
}

#[tokio::test]
async fn get_tx_hash_status_committed_success() {
    let mut provider = MockRadixProvider::new();

    provider.expect_get_tx_hash_status().returning(|_| {
        Ok(TransactionStatusResponse {
            status: gateway_api_client::models::TransactionStatus::CommittedSuccess,
            ..Default::default()
        })
    });

    let priv_key_vec = hex::decode(TEST_PRIVATE_KEY).expect("Failed to parse hex");
    let signer = RadixSigner::new(priv_key_vec, "rdx".into()).expect("Failed to create signer");

    let provider_arc = Arc::new(provider);
    let network = NetworkDefinition::mainnet();
    let adapter = adapter(&network, provider_arc.clone(), signer.clone());

    let hash = H512::zero();
    let tx_status = adapter
        .get_tx_hash_status(hash)
        .await
        .expect("Failed to get tx hash status");

    assert_eq!(tx_status, TransactionStatus::Finalized);
}
