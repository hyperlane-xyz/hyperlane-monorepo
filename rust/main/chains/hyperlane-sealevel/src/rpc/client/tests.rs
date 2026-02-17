use crate::client::SealevelRpcClient;

/// Regression test: slot 388662392 previously failed to parse with older solana-client versions.
#[tokio::test]
#[ignore] // requires network access to a Solana mainnet RPC
async fn test_get_block_parses_problematic_slot() {
    let client = SealevelRpcClient::new("https://api.mainnet-beta.solana.com".to_string());

    let slot = 388662392;
    let block = client
        .get_block(slot)
        .await
        .expect("failed to parse block at slot {slot}");

    assert!(
        block.blockhash.len() > 0,
        "expected non-empty blockhash for slot {slot}"
    );
}
