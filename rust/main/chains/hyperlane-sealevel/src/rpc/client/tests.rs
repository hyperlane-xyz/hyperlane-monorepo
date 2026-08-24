use std::sync::Arc;

use solana_client::nonblocking::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;

use super::block_config;
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

/// Regression: getBlock must not request rewards. Our pinned solana crates
/// can't deserialize newer reward types (e.g. `DeactivatedStake`), and a
/// SerdeJson parse failure on getBlock permanently stalls the sequence-aware
/// scraper cursor. The scraper never reads rewards, so they must stay
/// disabled. See ENG-4405.
#[test]
fn get_block_config_disables_rewards() {
    let config = block_config(CommitmentConfig::finalized());

    assert_eq!(config.rewards, Some(false));
    assert_eq!(config.max_supported_transaction_version, Some(0));
    assert_eq!(config.commitment, Some(CommitmentConfig::finalized()));
}
