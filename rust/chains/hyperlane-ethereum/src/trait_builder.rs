use std::fmt::{Debug, Write};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::middleware::gas_oracle::{
    GasCategory, GasOracle, GasOracleMiddleware, Polygon, ProviderOracle,
};
use ethers::prelude::{
    Http, JsonRpcClient, Middleware, NonceManagerMiddleware, Provider, Quorum, QuorumProvider,
    SignerMiddleware, WeightedProvider, Ws, WsClientError,
};
use hyperlane_core::metrics::agent::METRICS_SCRAPE_INTERVAL;
use hyperlane_core::rpc_clients::FallbackProvider;
use reqwest::{Client, Url};
use thiserror::Error;

use ethers_prometheus::json_rpc_client::{
    JsonRpcClientMetrics, JsonRpcClientMetricsBuilder, NodeInfo, PrometheusJsonRpcClient,
    PrometheusJsonRpcClientConfig,
};
use ethers_prometheus::middleware::{
    MiddlewareMetrics, PrometheusMiddleware, PrometheusMiddlewareConf,
};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneDomain, KnownHyperlaneDomain,
};

use crate::EthereumFallbackProvider;
use crate::{signers::Signers, ConnectionConf, RetryingProvider};

// This should be whatever the prometheus scrape interval is
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

/// An error when connecting to an ethereum provider.
#[derive(Error, Debug)]
pub enum EthereumProviderConnectionError {
    /// Underlying reqwest lib threw an error
    #[error(transparent)]
    ReqwestError(#[from] reqwest::Error),
    /// Underlying websocket library threw an error
    #[error(transparent)]
    WebsocketClientError(#[from] WsClientError),
}

impl From<EthereumProviderConnectionError> for ChainCommunicationError {
    fn from(e: EthereumProviderConnectionError) -> Self {
        ChainCommunicationError::from_other(e)
    }
}

/// A trait for dynamic trait creation with provider initialization.
#[async_trait]
pub trait BuildableWithProvider {
    /// The type that will be created.
    type Output;

    /// Construct a new instance of the associated trait using a connection
    /// config. This is the first step and will wrap the provider with
    /// metrics and a signer as needed.
    async fn build_with_connection_conf(
        &self,
        conn: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<Signers>,
        rpc_metrics: Option<JsonRpcClientMetrics>,
        middleware_metrics: Option<(MiddlewareMetrics, PrometheusMiddlewareConf)>,
    ) -> ChainResult<Self::Output> {
        Ok(match conn {
            ConnectionConf::HttpQuorum { urls } => {
                let mut builder = QuorumProvider::builder().quorum(Quorum::Majority);
                let http_client = Client::builder()
                    .timeout(HTTP_CLIENT_TIMEOUT)
                    .build()
                    .map_err(EthereumProviderConnectionError::from)?;
                for url in urls {
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
                    let metrics_provider = self.wrap_rpc_with_metrics(
                        http_provider,
                        url.clone(),
                        &rpc_metrics,
                        &middleware_metrics,
                    );
                    let retrying_provider =
                        RetryingProvider::new(metrics_provider, Some(5), Some(1000));
                    let weighted_provider = WeightedProvider::new(retrying_provider);
                    builder = builder.add_provider(weighted_provider);
                }
                let quorum_provider = builder.build();
                self.build(quorum_provider, locator, signer, middleware_metrics)
                    .await?
            }
            ConnectionConf::HttpFallback { urls } => {
                let mut builder = FallbackProvider::builder();
                let http_client = Client::builder()
                    .timeout(HTTP_CLIENT_TIMEOUT)
                    .build()
                    .map_err(EthereumProviderConnectionError::from)?;
                for url in urls {
                    let http_provider = Http::new_with_client(url.clone(), http_client.clone());
                    let metrics_provider = self.wrap_rpc_with_metrics(
                        http_provider,
                        url.clone(),
                        &rpc_metrics,
                        &middleware_metrics,
                    );
                    builder = builder.add_provider(metrics_provider);
                }
                let fallback_provider = builder.build();
                let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
                self.build(
                    ethereum_fallback_provider,
                    locator,
                    signer,
                    middleware_metrics,
                )
                .await?
            }
            ConnectionConf::Http { url } => {
                let http_client = Client::builder()
                    .timeout(HTTP_CLIENT_TIMEOUT)
                    .build()
                    .map_err(EthereumProviderConnectionError::from)?;
                let http_provider = Http::new_with_client(url.clone(), http_client);
                let metrics_provider = self.wrap_rpc_with_metrics(
                    http_provider,
                    url.clone(),
                    &rpc_metrics,
                    &middleware_metrics,
                );
                let retrying_http_provider = RetryingProvider::new(metrics_provider, None, None);
                self.build(retrying_http_provider, locator, signer, middleware_metrics)
                    .await?
            }
            ConnectionConf::Ws { url } => {
                let ws = Ws::connect(url)
                    .await
                    .map_err(EthereumProviderConnectionError::from)?;
                self.build(ws, locator, signer, middleware_metrics).await?
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

    /// Create the provider, applying any middlewares (e.g. gas oracle, signer, metrics) as needed,
    /// and then create the associated trait.
    async fn build<P>(
        &self,
        client: P,
        locator: &ContractLocator,
        signer: Option<Signers>,
        metrics: Option<(MiddlewareMetrics, PrometheusMiddlewareConf)>,
    ) -> ChainResult<Self::Output>
    where
        P: JsonRpcClient + 'static,
    {
        let provider = wrap_with_gas_oracle(Provider::new(client), locator.domain)?;

        Ok(if let Some(metrics) = metrics {
            let provider = Arc::new(PrometheusMiddleware::new(provider, metrics.0, metrics.1));
            // TODO: This task is spawned each time `.build_ethereum(...)` is called, which is about 15 times,
            // in spite of it doing the same thing, wasting resources.
            // Only spawn this once along with the other agent tasks.
            tokio::spawn(provider.start_updating_on_interval(METRICS_SCRAPE_INTERVAL));
            self.build_with_signer(provider, locator, signer).await?
        } else {
            self.build_with_signer(provider, locator, signer).await?
        })
    }

    /// Wrap the provider creation with a signing provider if signers were
    /// provided, and then create the associated trait.
    async fn build_with_signer<M>(
        &self,
        provider: M,
        locator: &ContractLocator,
        signer: Option<Signers>,
    ) -> ChainResult<Self::Output>
    where
        M: Middleware + 'static,
    {
        Ok(if let Some(signer) = signer {
            let signing_provider = wrap_with_signer(provider, signer)
                .await
                .map_err(ChainCommunicationError::from_other)?;
            self.build_with_provider(signing_provider, locator)
        } else {
            self.build_with_provider(provider, locator)
        }
        .await)
    }

    /// Construct a new instance of the associated trait using a provider.
    async fn build_with_provider<M>(&self, provider: M, locator: &ContractLocator) -> Self::Output
    where
        M: Middleware + 'static;
}

async fn wrap_with_signer<M: Middleware>(
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

fn build_polygon_gas_oracle(chain: ethers_core::types::Chain) -> ChainResult<Box<dyn GasOracle>> {
    let gas_oracle = Polygon::new(chain)
        .map_err(ChainCommunicationError::from_other)?
        .category(GasCategory::Standard);
    Ok(Box::new(gas_oracle) as Box<dyn GasOracle>)
}

/// Wrap the provider with a gas oracle middleware.
/// Polygon and Mumbai require using the Polygon gas oracle, see discussion here
/// https://github.com/foundry-rs/foundry/issues/1703.
/// Defaults to using the provider's gas oracle.
fn wrap_with_gas_oracle<M>(
    provider: M,
    domain: &HyperlaneDomain,
) -> ChainResult<GasOracleMiddleware<Arc<M>, Box<dyn GasOracle>>>
where
    M: Middleware + 'static,
{
    let provider = Arc::new(provider);
    let gas_oracle: Box<dyn GasOracle> = {
        match domain {
            HyperlaneDomain::Known(KnownHyperlaneDomain::Polygon) => {
                build_polygon_gas_oracle(ethers_core::types::Chain::Polygon)?
            }
            HyperlaneDomain::Known(KnownHyperlaneDomain::Mumbai) => {
                build_polygon_gas_oracle(ethers_core::types::Chain::PolygonMumbai)?
            }
            _ => Box::new(ProviderOracle::new(provider.clone())),
        }
    };
    Ok(GasOracleMiddleware::new(provider, gas_oracle))
}
