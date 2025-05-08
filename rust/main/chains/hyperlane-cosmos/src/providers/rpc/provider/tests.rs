use std::str::FromStr;

use tendermint_rpc::client::CompatMode;
use tendermint_rpc::HttpClient;
use url::Url;

use hyperlane_core::rpc_clients::FallbackProvider;
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};

use crate::rpc::CosmosRpcClient;
use crate::rpc_clients::CosmosFallbackProvider;

/// This test passes when HttpClient is initialised with `CompactMode::V0_37` (done in prod code).
/// This test fails when `CompactMode::V0_38` is used with Neutron url and block height.
/// This test passes with Osmosis url and block height and any compact mode.
#[tokio::test]
#[ignore]
async fn test_fallback_provider() {
    use tendermint_rpc::Client;

    // Neutron
    let url = "<neutron url>";
    let height = 22488720u32;

    // Osmosis
    // let url = "<osmosis url>";
    // let height = 15317185u32;

    let url = Url::from_str(url).unwrap();

    let metrics = PrometheusClientMetrics::default();

    let metrics_config = PrometheusConfig {
        connection_type: ClientConnectionType::Rpc,
        node: None,
        chain: None,
    };
    let rpc_client = CosmosRpcClient::from_url(&url, metrics.clone(), metrics_config).unwrap();
    let providers = [rpc_client];

    let mut builder = FallbackProvider::builder();
    builder = builder.add_providers(providers);
    let fallback_provider = builder.build();
    let provider = CosmosFallbackProvider::new(fallback_provider);

    let response = provider
        .call(|provider| Box::pin(async move { provider.get_block(height).await }))
        .await
        .unwrap();

    println!("{:?}", response);
}
