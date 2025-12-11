//! Tests for AleoProvider high level functions using a mock underlying HttpClient.

use std::{ops::Deref, path::PathBuf, str::FromStr};

use hyperlane_core::{HyperlaneProvider, H256, U256};
use serde_json::{json, Value};

use crate::{provider::mock::MockHttpClient, AleoProvider, AleoSigner};

// Helper constructing provider with mock client
fn mock_provider() -> AleoProvider<MockHttpClient> {
    let base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/provider/mock_responses");
    let client: MockHttpClient = MockHttpClient::new(base_path);
    let domain =
        hyperlane_core::HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Abstract);
    AleoProvider::with_client(client, domain, 0u16, None)
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
async fn test_get_txn_by_hash_defaults() {
    let provider = mock_provider();
    provider
        .deref()
        .register_file(
            "transaction/at16e9kg860d3d44yvyqswp8drwm249h2s8pwv7ylalzhcgyc5njcxqs7rr89",
            "transaction_no_sender.json",
        )
        .unwrap();
    let hash = H256::from_str("d64b641f4f6c5b5a9184041c13b46edaaa5baa070b99e27fbf15f0826293960c")
        .unwrap()
        .into();

    let tx = provider.get_txn_by_hash(&hash).await.unwrap();
    assert_eq!(tx.hash, hash);
    assert_eq!(tx.sender, H256::default());
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

// Missing blocks or transactions are indicated by corresponding HTTP responses where Reqwest handles the errors.
// Following message can be expected in such cases:
//
// Err(Other(ReqwestError(reqwest::Error {
//     kind: Status(404),
//     url: Url {
//         scheme: "https",
//         cannot_be_a_base: false,
//         username: "",
//         password: None,
//         host: Some(Domain("api.explorer.provable.com")),
//         port: None,
//         path: "/v1/mainnet//transaction/at16e9kg860d3d44yvyqswp8drwm249h2s8pwv7ylalzhcg...",
//         ...
//     }
// })))

fn get_mock_provider_with_programs() -> AleoProvider<MockHttpClient> {
    let base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/provider/mock_responses");
    let client: MockHttpClient = MockHttpClient::new(base_path);
    let domain =
        hyperlane_core::HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Abstract);
    let private_key =
        hex::decode("5e5b34fbf0e6e22375fde0d2af0dcd789bd607a9423ece32bc281d7a28fa3612").unwrap();
    let signer = AleoSigner::new(&private_key).unwrap();
    let provider = AleoProvider::with_client(client, domain, 0u16, Some(signer));
    provider
        .register_file("program/credits.aleo", "programs/credits.aleo")
        .unwrap();
    provider
        .register_file("program/hook_manager.aleo", "programs/hook_manager.aleo")
        .unwrap();
    provider
        .register_file("program/ism_manager.aleo", "programs/ism_manager.aleo")
        .unwrap();
    provider
        .register_file("program/mailbox.aleo", "programs/mailbox.aleo")
        .unwrap();
    provider.register_value("block/height/latest", json!(12668791));
    provider.register_value("program/unknown.aleo", Value::Null);
    provider
}

#[tokio::test]
async fn test_estimate_tx() {
    let provider = get_mock_provider_with_programs();
    let result = provider
        .estimate_tx(
            "credits.aleo",
            "transfer_public",
            vec![
                "aleo1qkjr490qe7p9v45qrd5pjemmqn4vmgqt8vzc8j0jfwhc7mf5f5zqly7vze".to_owned(),
                "5u64".to_owned(),
            ],
        )
        .await;
    assert!(result.is_ok(), "Estimate TX should succeed");
    let result = result.unwrap();
    assert_eq!(result.base_fee, 4030);
    assert_eq!(result.priority_fee, 0u64);
    assert_eq!(result.total_fee, 4030);
}

#[tokio::test]
async fn test_estimate_tx_invalid_inputs() {
    let provider = get_mock_provider_with_programs();
    // transfer_public takes 2 inputs, providing 3 should fail
    let result = provider
        .estimate_tx(
            "credits.aleo",
            "transfer_public",
            vec![
                "aleo1qkjr490qe7p9v45qrd5pjemmqn4vmgqt8vzc8j0jfwhc7mf5f5zqly7vze".to_owned(),
                "5u64".to_owned(),
                "5u64".to_owned(),
            ],
        )
        .await;
    assert!(
        !result.is_ok(),
        "Estimate TX with invalid arguments should fail"
    );
}

#[tokio::test]
async fn test_estimate_tx_unknown_function() {
    let provider = get_mock_provider_with_programs();
    // transfer_public_super does not exist
    let result = provider
        .estimate_tx(
            "credits.aleo",
            "transfer_public_super",
            vec![
                "aleo1qkjr490qe7p9v45qrd5pjemmqn4vmgqt8vzc8j0jfwhc7mf5f5zqly7vze".to_owned(),
                "5u64".to_owned(),
            ],
        )
        .await;
    assert!(
        !result.is_ok(),
        "Estimate TX with unknown function should fail"
    );
}

#[tokio::test]
async fn test_estimate_tx_unknown_program() {
    let provider = get_mock_provider_with_programs();
    // unknown.aleo does not exist
    let result = provider
        .estimate_tx(
            "unknown.aleo",
            "transfer_public",
            vec![
                "aleo1qkjr490qe7p9v45qrd5pjemmqn4vmgqt8vzc8j0jfwhc7mf5f5zqly7vze".to_owned(),
                "5u64".to_owned(),
            ],
        )
        .await;
    assert!(
        !result.is_ok(),
        "Estimate TX with unknown program should fail"
    );
}

#[tokio::test]
async fn test_program_with_imports() {
    let provider = get_mock_provider_with_programs();
    let result = provider
        .estimate_tx(
            "mailbox.aleo",
            "main",
            vec!["5u32".to_owned(), "5u32".to_owned()],
        )
        .await;
    assert!(result.is_ok(), "Estimate TX should succeed");
}
