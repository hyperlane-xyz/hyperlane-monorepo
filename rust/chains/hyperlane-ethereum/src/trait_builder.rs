use std::fmt::Write;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::prelude::{
    Http, JsonRpcClient, Middleware, NonceManagerMiddleware, Provider, Quorum, QuorumProvider,
    SignerMiddleware, WeightedProvider, Ws,
};
use reqwest::{Client, Url};

use ethers_prometheus::json_rpc_client::{
    JsonRpcClientMetrics, JsonRpcClientMetricsBuilder, NodeInfo, PrometheusJsonRpcClient,
    PrometheusJsonRpcClientConfig,
};
use ethers_prometheus::middleware::{
    MiddlewareMetrics, PrometheusMiddleware, PrometheusMiddlewareConf,
};
use hyperlane_core::{ContractLocator, Signers};

use crate::{Connection, RetryingProvider};

// This should be whatever the prometheus scrape interval is
const METRICS_SCRAPE_INTERVAL: Duration = Duration::from_secs(60);
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

/// A trait for dynamic trait creation with provider initialization.

#[async_trait]
pub trait MakeableWithProvider: Sync {
    /// The type that will be created.
    type Output;

    /// Construct a new instance of the associated trait using a connection
    /// config. This is the first step and will wrap the provider with
    /// metrics and a signer as needed.
    async fn make_with_connection(
        &self,
        conn: Connection,
        locator: &ContractLocator,
        signer: Option<Signers>,
        rpc_metrics: Option<impl FnOnce() -> JsonRpcClientMetrics + Send>,
        middleware_metrics: Option<(MiddlewareMetrics, PrometheusMiddlewareConf)>,
    ) -> eyre::Result<Self::Output> {
        Ok(match conn {
            Connection::HttpQuorum { urls } => {
                let rpc_metrics = rpc_metrics.map(|f| f());
                let mut builder = QuorumProvider::builder().quorum(Quorum::Majority);
                let http_client = Client::builder().timeout(HTTP_CLIENT_TIMEOUT).build()?;
                for url in urls.split(',') {
                    let http_provider =
                        Http::new_with_client(url.parse::<Url>()?, http_client.clone());
                    // Wrap the inner providers as RetryingProviders rather than the QuorumProvider.
                    // We've observed issues where the QuorumProvider will first get the latest
                    // block number and then submit an RPC at that block height,
                    // sometimes resulting in the second RPC getting serviced by
                    // a node that isn't aware of the requested block
                    // height yet. Retrying at the QuorumProvider level will result in both those
                    // RPCs being retried, while retrying at the inner provider
                    // level will result in only the second RPC being retried
                    // (the one with the error), which is the desired behavior.
                    let retrying_provider =
                        RetryingProvider::new(http_provider, Some(5), Some(1000));
                    let metrics_provider = self.wrap_rpc_with_metrics(
                        retrying_provider,
                        Url::parse(url)?,
                        &rpc_metrics,
                        &middleware_metrics,
                    );
                    let weighted_provider = WeightedProvider::new(metrics_provider);
                    builder = builder.add_provider(weighted_provider);
                }
                let quorum_provider = builder.build();
                self.wrap_with_metrics(quorum_provider, locator, signer, middleware_metrics)
                    .await?
            }
            Connection::Http { url } => {
                let http_client = Client::builder().timeout(HTTP_CLIENT_TIMEOUT).build()?;
                let http_provider = Http::new_with_client(url.parse::<Url>()?, http_client);
                let retrying_http_provider: RetryingProvider<Http> =
                    RetryingProvider::new(http_provider, None, None);
                self.wrap_with_metrics(retrying_http_provider, locator, signer, middleware_metrics)
                    .await?
            }
            Connection::Ws { url } => {
                let ws = Ws::connect(url).await?;
                self.wrap_with_metrics(ws, locator, signer, middleware_metrics)
                    .await?
            }
        })
    }

    /// Wrap a JsonRpcClient with metrics for use with a quorum provider.
    fn wrap_rpc_with_metrics<C>(
        &self,
        client: C,
        url: Url,
        rpc_metrics: &Option<JsonRpcClientMetrics>,
        middleware_metrics: &Option<(MiddlewareMetrics, PrometheusMiddlewareConf)>,
    ) -> PrometheusJsonRpcClient<C> {
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
    async fn wrap_with_metrics<P>(
        &self,
        client: P,
        locator: &ContractLocator,
        signer: Option<Signers>,
        metrics: Option<(MiddlewareMetrics, PrometheusMiddlewareConf)>,
    ) -> eyre::Result<Self::Output>
    where
        P: JsonRpcClient + 'static,
    {
        let provider = Provider::new(client);
        Ok(if let Some(metrics) = metrics {
            let provider = Arc::new(PrometheusMiddleware::new(provider, metrics.0, metrics.1));
            tokio::spawn(provider.start_updating_on_interval(METRICS_SCRAPE_INTERVAL));
            self.wrap_with_signer(provider, locator, signer).await?
        } else {
            self.wrap_with_signer(provider, locator, signer).await?
        })
    }

    /// Wrap the provider creation with a signing provider if signers were
    /// provided; this is the third step.
    async fn wrap_with_signer<M>(
        &self,
        provider: M,
        locator: &ContractLocator,
        signer: Option<Signers>,
    ) -> eyre::Result<Self::Output>
    where
        M: Middleware + 'static,
    {
        Ok(if let Some(signer) = signer {
            let signing_provider = make_signing_provider(provider, signer).await?;
            self.make_with_provider(signing_provider, locator)
        } else {
            self.make_with_provider(provider, locator)
        }
        .await)
    }

    /// Construct a new instance of the associated trait using a provider.
    async fn make_with_provider<M>(&self, provider: M, locator: &ContractLocator) -> Self::Output
    where
        M: Middleware + 'static;
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
