use std::sync::Arc;

use solana_client::nonblocking::rpc_client::RpcClient;

use crate::client::SealevelRpcClient;

//#[tokio::test]
async fn _test_get_block() {
    let rpc_client = RpcClient::new("<solana-rpc>".to_string());
    // given
    let client = SealevelRpcClient::from_rpc_client(Arc::new(rpc_client));

    // when
    let slot = 301337842; // block which requires latest version of solana-client
    let result = client.get_block(slot).await;

    // then
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_get_block_alchemy() {
    let client =
        SealevelRpcClient::new("https://solana-mainnet.g.alchemy.com/v2/<redacted>".to_string());

    let slot = 388662392;
    let result = client.get_block(slot).await;

    println!("get_block result for slot {}: {:?}", slot, result);
    assert!(result.is_ok(), "get_block failed: {:?}", result.err());
}
