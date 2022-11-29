use std::fmt::Write;
use std::sync::Arc;
use std::time::Duration;

use ethers::prelude::{
    Http, JsonRpcClient, Middleware, NonceManagerMiddleware, Provider, Quorum, QuorumProvider,
    SignerMiddleware, WeightedProvider, Ws,
};
use reqwest::{Client, Url};

use abacus_core::Signers;
use ethers_prometheus::json_rpc_client::{
    JsonRpcClientMetrics, JsonRpcClientMetricsBuilder, NodeInfo, PrometheusJsonRpcClient,
    PrometheusJsonRpcClientConfig,
};
use ethers_prometheus::middleware::{
    MiddlewareMetrics, PrometheusMiddleware, PrometheusMiddlewareConf,
};

use crate::dynamic::{DynamicJsonRpcClient, DynamicMiddleware};
use crate::{Connection, RetryingProvider};

// This should be whatever the prometheus scrape interval is
const METRICS_SCRAPE_INTERVAL: Duration = Duration::from_secs(60);
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

/// Construct a new instance of the associated trait using a connection
/// config. This is the first step and will wrap the provider with
/// metrics and a signer as needed.
pub async fn make_with_connection(
    conn: Connection,
    signer: Option<Signers>,
    rpc_metrics: Option<JsonRpcClientMetrics>,
    middleware_metrics: Option<(MiddlewareMetrics, PrometheusMiddlewareConf)>,
) -> eyre::Result<DynamicMiddleware> {
    match conn {
        Connection::HttpQuorum { urls } => {
            let mut builder = QuorumProvider::builder().quorum(Quorum::Majority);
            let http_client = Client::builder().timeout(HTTP_CLIENT_TIMEOUT).build()?;
            for url in urls.split(',') {
                let url: Url = url.parse()?;
                let http_provider = Http::new_with_client(url.clone(), http_client.clone());
                // Wrap the inner providers as RetryingProviders rather than the QuorumProvider.
                // We've observed issues where the QuorumProvider will first get the latest
                // block number and then submit an RPC at that block height,
                // sometimes resulting in the second RPC getting serviced by
                // a node that isn't aware of the requested block
                // height yet. Retrying at the QuorumProvider level will result in both those
                // RPCs being retried, while retrying at the inner provider
                // level will result in only the second RPC being retried
                // (the one with the error), which is the desired behavior.
                let metrics_provider =
                    wrap_rpc_with_metrics(http_provider, url, &rpc_metrics, &middleware_metrics);
                let retrying_provider =
                    RetryingProvider::new(metrics_provider, Some(5), Some(1000));
                let dyn_provider = DynamicJsonRpcClient::from(retrying_provider);
                let weighted_provider = WeightedProvider::new(dyn_provider);
                builder = builder.add_provider(weighted_provider);
            }
            let quorum_provider: QuorumProvider<DynamicJsonRpcClient> = builder.build();
            wrap_with_metrics(quorum_provider, signer, middleware_metrics).await
        }
        Connection::Http { url } => {
            let url: Url = url.parse()?;
            let http_client = Client::builder().timeout(HTTP_CLIENT_TIMEOUT).build()?;
            let http_provider = Http::new_with_client(url.clone(), http_client);
            let metrics_provider: PrometheusJsonRpcClient<Http> =
                wrap_rpc_with_metrics(http_provider, url, &rpc_metrics, &middleware_metrics);
            let retrying_http_provider: RetryingProvider<PrometheusJsonRpcClient<Http>> =
                RetryingProvider::new(metrics_provider, None, None);
            wrap_with_metrics(retrying_http_provider, signer, middleware_metrics).await
        }
        Connection::Ws { url } => {
            let ws = Ws::connect(&url).await?;
            let metrics_provider =
                wrap_rpc_with_metrics(ws, url.parse()?, &rpc_metrics, &middleware_metrics);
            wrap_with_metrics(metrics_provider, signer, middleware_metrics).await
        }
    }
}

/// Wrap a JsonRpcClient with metrics.
fn wrap_rpc_with_metrics<C>(
    client: C,
    url: Url,
    rpc_metrics: &Option<JsonRpcClientMetrics>,
    middleware_metrics: &Option<(MiddlewareMetrics, PrometheusMiddlewareConf)>,
) -> PrometheusJsonRpcClient<C>
where
    PrometheusJsonRpcClient<C>: JsonRpcClient,
{
    PrometheusJsonRpcClient::new(
        client,
        rpc_metrics
            .clone()
            .unwrap_or_else(|| JsonRpcClientMetricsBuilder::default().build().unwrap()),
        PrometheusJsonRpcClientConfig {
            node: Some(NodeInfo {
                host: {
                    let mut s = String::new();
                    if let Some(host) = url.host_str() {
                        s.push_str(host);
                        if let Some(port) = url.port() {
                            write!(&mut s, ":{port}").unwrap();
                        }
                        Some(s)
                    } else {
                        None
                    }
                },
            }),
            // steal the chain info from the middleware conf
            chain: middleware_metrics
                .as_ref()
                .and_then(|(_, v)| v.chain.clone()),
        },
    )
}

/// Wrap the provider creation with metrics if provided; this is the second
/// step
async fn wrap_with_metrics<C>(
    client: C,
    signer: Option<Signers>,
    metrics: Option<(MiddlewareMetrics, PrometheusMiddlewareConf)>,
) -> eyre::Result<DynamicMiddleware>
where
    C: Into<DynamicJsonRpcClient>,
{
    let provider: Provider<DynamicJsonRpcClient> = Provider::new(client.into());
    Ok(if let Some(metrics) = metrics {
        let provider = PrometheusMiddleware::new(provider, metrics.0, metrics.1);
        tokio::spawn(provider.start_updating_on_interval(METRICS_SCRAPE_INTERVAL));
        wrap_with_signer::<Arc<PrometheusMiddleware<Provider<DynamicJsonRpcClient>>>>(
            provider, signer,
        )
        .await?
    } else {
        wrap_with_signer::<Provider<DynamicJsonRpcClient>>(provider, signer).await?
    })
}

/// Wrap the provider creation with a signing provider if signers were
/// provided; this is the third step.
async fn wrap_with_signer<M>(
    provider: M,
    signer: Option<Signers>,
) -> eyre::Result<DynamicMiddleware>
where
    M: Middleware + 'static,
    DynamicMiddleware: From<SignerMiddleware<NonceManagerMiddleware<M>, Signers>> + From<M>,
{
    Ok(if let Some(signer) = signer {
        let signing_provider = make_signing_provider(provider, signer).await?;
        DynamicMiddleware::from(signing_provider)
    } else {
        DynamicMiddleware::from(provider)
    })
}

async fn make_signing_provider<M: Middleware>(
    provider: M,
    signer: Signers,
) -> Result<SignerMiddleware<NonceManagerMiddleware<M>, Signers>, M::Error> {
    let provider_chain_id = provider.get_chainid().await?;
    let signer = ethers::signers::Signer::with_chain_id(signer, provider_chain_id.as_u64());

    let address = ethers::prelude::Signer::address(&signer);
    let provider = NonceManagerMiddleware::new(provider, address);

    let signing_provider = SignerMiddleware::new(provider, signer);
    Ok(signing_provider)
}
