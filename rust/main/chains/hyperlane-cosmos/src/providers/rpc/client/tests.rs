use crate::HyperlaneCosmosError;
use std::str::FromStr;
use tendermint_rpc::client::CompatMode;
use tendermint_rpc::endpoint::{block, block_results};
use tendermint_rpc::{Client, HttpClient, Url};
use tracing::debug;

/// This test passes when HttpClient is initialised with `CompactMode::V0_37`.
/// This fails when `CompactMode::V0_38` is used with Neutron url and block height.
/// This test passes with Osmosis url and block height and any compact mode.
#[tokio::test]
#[ignore]
async fn test_http_client() {
    use tendermint_rpc::Client;

    // Neutron
    // let url = "<neutron url>";
    // let height = 22488720u32;

    // Osmosis
    // let url = "<osmosis url>";
    // let height = 15317185u32;

    // Injective
    let url = "<Injective url>";
    let height = 127361588u32;
    // let height = 127742354u32;

    let url = Url::from_str(url).unwrap();
    let tendermint_url = tendermint_rpc::Url::try_from(url).unwrap();
    let url = tendermint_rpc::HttpClientUrl::try_from(tendermint_url).unwrap();

    let client = HttpClient::builder(url)
        .compat_mode(CompatMode::V0_37)
        .build()
        .unwrap();

    let block: block::Response = client.block(height).await.unwrap();
    let block_results: block_results::Response = client.block_results(height).await.unwrap();

    // println!("Block: {:?}", block);
    // println!("Block Results: {:?}", block_results);
}
