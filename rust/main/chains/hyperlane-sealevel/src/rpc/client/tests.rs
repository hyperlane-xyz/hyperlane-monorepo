use crate::SealevelRpcClient;

//#[tokio::test]
async fn _test_get_block() {
    // given
    let client = SealevelRpcClient::new("<solana-rpc>".to_string());

    // when
    let slot = 301337842; // block which requires latest version of solana-client
    let result = client.get_block(slot).await;

    // then
    assert!(result.is_ok());
}
