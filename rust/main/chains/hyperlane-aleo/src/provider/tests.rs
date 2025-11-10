//! Tests for AleoProvider high level functions using a mock underlying HttpClient.
//! NOTE: JSON response files are empty placeholders; populate them with valid snarkVM JSON to enable test execution.
//! Until populated, these tests will be ignored.

use std::{ops::Deref, path::PathBuf, str::FromStr};

use hyperlane_core::{HyperlaneProvider, H256, U256};

use crate::{provider::mock::MockHttpClient, AleoProvider};

// Helper constructing provider with mock client
fn mock_provider() -> AleoProvider<MockHttpClient> {
    let base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/provider/mock_responses");
    let client: MockHttpClient = MockHttpClient::new(base_path);
    let domain =
        hyperlane_core::HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Abstract);
    AleoProvider::with_client(client, domain, 0u16)
}

#[tokio::test]
async fn test_get_block_by_height() {
    let provider = mock_provider();
    provider
        .deref()
        .register_file("block/1", "block_1.json")
        .unwrap();

    let block_info = HyperlaneProvider::get_block_by_height(&provider, 1u64)
        .await
        .unwrap();
    assert_eq!(block_info.number, 1);
    assert_eq!(block_info.timestamp, 1725479626);
    assert_eq!(
        block_info.hash,
        H256::from_str("2306b5c843f34abe2bbac9e6f2bcfdda0926b50cd6f736dfd419aceed6b7c710").unwrap()
    );
}

#[tokio::test]
async fn test_get_txn_by_hash() {
    let provider = mock_provider();
    provider
        .deref()
        .register_file(
            "transaction/at167klxfxjj7maxyw0wvjp2am08uqv7xajqzupd792rs7e2dufrufq5ym895",
            "transaction_sample.json",
        )
        .unwrap();
    let hash = H256::from_str("d7adf324d297b7d311cf732415776f3f00cf1bb200b816f8aa1c3d9537891f12")
        .unwrap()
        .into();
    let sender =
        H256::from_str("d696b4433984cfeb0af28ea882f751d232df1d7182b2d7cbc3e8afae61d61c01").unwrap();
    let recipient =
        H256::from_str("05a43a95e0cf825656801b6819677b04eacda00b3b0583c9f24baf8f6d344d04").unwrap();
    let gas_limit = U256::from(1482);

    let tx = provider.get_txn_by_hash(&hash).await.unwrap();
    assert_eq!(tx.hash, hash);
    assert_eq!(tx.gas_limit, gas_limit);
    assert_eq!(tx.max_priority_fee_per_gas, None);
    assert_eq!(tx.max_fee_per_gas, Some(U256::one()));
    assert_eq!(tx.gas_price, Some(U256::one()));
    assert_eq!(tx.nonce, 0);
    assert_eq!(tx.sender, sender);
    assert_eq!(tx.recipient, Some(recipient));
    assert_eq!(tx.raw_input_data, None);
}

#[tokio::test]
async fn test_get_balance() {
    let provider = mock_provider();
    provider
        .deref()
        .register_file(
            "program/credits.aleo/mapping/account/aleo1qkjr490qe7p9v45qrd5pjemmqn4vmgqt8vzc8j0jfwhc7mf5f5zqly7vze",
            "account_balance.json",
        )
        .unwrap();
    let result = provider
        .get_balance("aleo1qkjr490qe7p9v45qrd5pjemmqn4vmgqt8vzc8j0jfwhc7mf5f5zqly7vze".to_string())
        .await;
    assert_eq!(result.unwrap(), U256::from(1000u64));
}

#[tokio::test]
async fn test_get_chain_metrics() {
    let provider = mock_provider();
    provider
        .deref()
        .register_file("block/height/latest", "latest_height.json")
        .unwrap();
    provider
        .deref()
        .register_file("block/1", "block_1.json")
        .unwrap();
    let block_info = provider.get_chain_metrics().await.unwrap().unwrap();
    assert_eq!(block_info.latest_block.number, 1);
    assert_eq!(block_info.latest_block.timestamp, 1725479626);
    assert_eq!(
        block_info.latest_block.hash,
        H256::from_str("2306b5c843f34abe2bbac9e6f2bcfdda0926b50cd6f736dfd419aceed6b7c710").unwrap()
    );
}
