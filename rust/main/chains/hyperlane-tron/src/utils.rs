use std::time::Duration;

use ethers::providers::Http;
use reqwest::Client;
use url::Url;

use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, PrometheusJsonRpcClient};
use hyperlane_core::{rpc_clients::FallbackProvider, ChainCommunicationError, ChainResult};
use hyperlane_ethereum::EthereumFallbackProvider;
use hyperlane_metric::prometheus_metric::{
    self, ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use reqwest_utils::parse_custom_rpc_headers;

use crate::HyperlaneTronError;

const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) type JsonProvider = EthereumFallbackProvider<
    PrometheusJsonRpcClient<Http>,
    JsonRpcBlockGetter<PrometheusJsonRpcClient<Http>>,
>;

pub(crate) fn build_fallback_provider(
    rpcs: &Vec<Url>,
    metrics: PrometheusClientMetrics,
    chain: Option<prometheus_metric::ChainInfo>,
) -> ChainResult<JsonProvider> {
    let mut builder = FallbackProvider::builder();
    for url in rpcs {
        let url = url.clone().to_string() + "jsonrpc";
        let url = Url::parse(&url)
            .map_err(|e| HyperlaneTronError::RestApiError(format!("invalid URL: {e}")))?;
        let http_provider = build_http_provider(url.clone())?;
        let metrics_provider =
            wrap_rpc_with_metrics(http_provider, url.clone(), metrics.clone(), chain.clone());
        builder = builder.add_provider(metrics_provider);
    }
    let fallback_provider = builder.build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider, false);

    Ok(ethereum_fallback_provider)
}

/// Wrap a JsonRpcClient with metrics for use with a quorum provider.
fn wrap_rpc_with_metrics<C>(
    client: C,
    url: Url,
    metrics: PrometheusClientMetrics,
    chain: Option<prometheus_metric::ChainInfo>,
) -> PrometheusJsonRpcClient<C> {
    PrometheusJsonRpcClient::new(
        client,
        metrics,
        PrometheusConfig::from_url(&url, ClientConnectionType::Rpc, chain),
    )
}

fn build_http_provider(url: Url) -> ChainResult<Http> {
    let client = get_reqwest_client(&url)?;
    Ok(Http::new_with_client(url, client))
}

/// Gets a cached reqwest client for the given URL, or builds a new one if it doesn't exist.
fn get_reqwest_client(url: &Url) -> ChainResult<Client> {
    let (headers, _) =
        parse_custom_rpc_headers(url).map_err(ChainCommunicationError::from_other)?;
    let client = Client::builder()
        .timeout(HTTP_CLIENT_TIMEOUT)
        .default_headers(headers)
        .build()
        .map_err(HyperlaneTronError::from)?;

    Ok(client)
}
