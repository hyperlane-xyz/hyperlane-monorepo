use std::fmt::Write;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::prelude::{
    Http, JsonRpcClient, Middleware, NonceManagerMiddleware, Provider, Quorum, QuorumProvider,
    SignerMiddleware, WeightedProvider, Ws, WsClientError,
};
use reqwest::{Client, Url};
use thiserror::Error;

use ethers_prometheus::json_rpc_client::{
    JsonRpcClientMetrics, JsonRpcClientMetricsBuilder, NodeInfo, PrometheusJsonRpcClient,
    PrometheusJsonRpcClientConfig,
};
use ethers_prometheus::middleware::{
    MiddlewareMetrics, PrometheusMiddleware, PrometheusMiddlewareConf,
};
use hyperlane_core::{ChainCommunicationError, ChainResult, ContractLocator, Signers};

use crate::{ConnectionConf, RetryingProvider};

// This should be whatever the prometheus scrape interval is
const METRICS_SCRAPE_INTERVAL: Duration = Duration::from_secs(60);
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(60);

/// An error when connecting to an ethereum provider.
#[derive(Error, Debug)]
pub enum EthereumProviderConnectionError {
    /// Underlying reqwest lib threw an error
    #[error(transparent)]
    ReqwestError(#[from] reqwest::Error),
    /// A URL string could not be parsed
    #[error("Failed to parse url {1:?}: {0}")]
    InvalidUrl(url::ParseError, String),
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
        conn: ConnectionConf,
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
                for url in urls.split(',') {
                    let parsed_url = url.parse::<Url>().map_err(|e| {
                        EthereumProviderConnectionError::InvalidUrl(e, url.to_owned())
                    })?;
                    let http_provider = Http::new_with_client(
                        parsed_url.clone(),
                        http_client.clone(),
                    );
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
                        parsed_url,
                        &rpc_metrics,
                        &middleware_metrics,
                    );
                    let retrying_provider =
                        RetryingProvider::new(metrics_provider, Some(5), Some(1000));
                    let weighted_provider = WeightedProvider::new(retrying_provider);
                    builder = builder.add_provider(weighted_provider);
                }
                let quorum_provider = builder.build();
                self.wrap_with_metrics(quorum_provider, locator, signer, middleware_metrics)
                    .await?
            }
            ConnectionConf::Http { url } => {
                let http_client = Client::builder()
                    .timeout(HTTP_CLIENT_TIMEOUT)
                    .build()
                    .map_err(EthereumProviderConnectionError::from)?;
                let parsed_url = url.parse::<Url>()
                    .map_err(|e| EthereumProviderConnectionError::InvalidUrl(e, url))?;
                let http_provider = Http::new_with_client(
                    parsed_url.clone(),
                    http_client,
                );
                let metrics_provider = self.wrap_rpc_with_metrics(
                    http_provider,
                    parsed_url,
                    &rpc_metrics,
                    &middleware_metrics,
                );
                let retrying_http_provider: RetryingProvider<Http> =
                    RetryingProvider::new(metrics_provider, None, None);
                self.wrap_with_metrics(retrying_http_provider, locator, signer, middleware_metrics)
                    .await?
            }
            ConnectionConf::Ws { url } => {
                let ws = Ws::connect(url)
                    .await
                    .map_err(EthereumProviderConnectionError::from)?;
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
    ) -> ChainResult<Self::Output>
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
    ) -> ChainResult<Self::Output>
    where
        M: Middleware + 'static,
    {
        Ok(if let Some(signer) = signer {
            let signing_provider = build_signing_provider(provider, signer)
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

async fn build_signing_provider<M: Middleware>(
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
