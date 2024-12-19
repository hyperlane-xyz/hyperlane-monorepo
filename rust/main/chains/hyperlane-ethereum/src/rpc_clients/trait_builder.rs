use std::fmt::{Debug, Write};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::middleware::gas_escalator::{Frequency, GasEscalatorMiddleware, GeometricGasPrice};
use ethers::middleware::gas_oracle::{
    GasCategory, GasOracle, GasOracleMiddleware, Polygon, ProviderOracle,
};
use ethers::prelude::{
    Http, JsonRpcClient, Middleware, NonceManagerMiddleware, Provider, Quorum, QuorumProvider,
    SignerMiddleware, WeightedProvider, Ws, WsClientError,
};
use ethers::types::Address;
use ethers_signers::Signer;
use hyperlane_core::rpc_clients::FallbackProvider;
use reqwest::{Client, Url};
use thiserror::Error;

use ethers_prometheus::json_rpc_client::{
    JsonRpcBlockGetter, JsonRpcClientMetrics, JsonRpcClientMetricsBuilder, NodeInfo,
    PrometheusJsonRpcClient, PrometheusJsonRpcClientConfig,
};
use ethers_prometheus::middleware::{MiddlewareMetrics, PrometheusMiddlewareConf};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneDomain, KnownHyperlaneDomain,
};
use tracing::instrument;

use crate::signer::Signers;
use crate::{ConnectionConf, EthereumFallbackProvider, RetryingProvider, RpcConnectionConf};

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

    /// Whether this provider requires a signer
    const NEEDS_SIGNER: bool;

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
        Ok(match &conn.rpc_connection {
            RpcConnectionConf::HttpQuorum { urls } => {
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
                self.build(quorum_provider, conn, locator, signer).await?
            }
            RpcConnectionConf::HttpFallback { urls } => {
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
                let ethereum_fallback_provider = EthereumFallbackProvider::<
                    _,
                    JsonRpcBlockGetter<PrometheusJsonRpcClient<Http>>,
                >::new(fallback_provider);
                self.build(ethereum_fallback_provider, conn, locator, signer)
                    .await?
            }
            RpcConnectionConf::Http { url } => {
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
                self.build(retrying_http_provider, conn, locator, signer)
                    .await?
            }
            RpcConnectionConf::Ws { url } => {
                let ws = Ws::connect(url)
                    .await
                    .map_err(EthereumProviderConnectionError::from)?;
                self.build(ws, conn, locator, signer).await?
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

    /// Create the provider, applying any middlewares (e.g. gas oracle, signer) as needed,
    /// and then create the associated trait.
    async fn build<P>(
        &self,
        client: P,
        conn: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<Signers>,
    ) -> ChainResult<Self::Output>
    where
        P: JsonRpcClient + 'static,
    {
        self.build_with_signer(Provider::new(client), conn, locator, signer)
            .await
    }

    /// Wrap the provider creation with a signing provider if signers were
    /// provided, and then create the associated trait.
    #[instrument(skip(self, provider, conn, locator, signer), fields(domain=locator.domain.name()), level = "debug")]
    async fn build_with_signer<M>(
        &self,
        provider: M,
        conn: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<Signers>,
    ) -> ChainResult<Self::Output>
    where
        M: Middleware + 'static,
    {
        Ok(if let Some(signer) = signer {
            // The signing provider is used for sending txs, which may end up stuck in the mempool due to
            // gas pricing issues. We first wrap the provider in a signer middleware, to sign any new txs sent by the gas escalator middleware.
            // We keep nonce manager as the outermost middleware, so that every new tx with a higher gas price reuses the same nonce.
            let signing_provider = wrap_with_signer(provider, signer.clone())
                .await
                .map_err(ChainCommunicationError::from_other)?;
            let gas_escalator_provider = wrap_with_gas_escalator(signing_provider);
            let gas_oracle_provider = wrap_with_gas_oracle(gas_escalator_provider, locator.domain)?;
            let nonce_manager_provider =
                wrap_with_nonce_manager(gas_oracle_provider, signer.address())
                    .await
                    .map_err(ChainCommunicationError::from_other)?;

            self.build_with_provider(nonce_manager_provider, conn, locator)
        } else {
            self.build_with_provider(provider, conn, locator)
        }
        .await)
    }

    /// Construct a new instance of the associated trait using a provider.
    async fn build_with_provider<M>(
        &self,
        provider: M,
        conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output
    where
        M: Middleware + 'static;
}

async fn wrap_with_signer<M: Middleware>(
    provider: M,
    signer: Signers,
) -> Result<SignerMiddleware<M, Signers>, M::Error> {
    let provider_chain_id = provider.get_chainid().await?;
    let signer = ethers::signers::Signer::with_chain_id(signer, provider_chain_id.as_u64());

    Ok(SignerMiddleware::new(provider, signer))
}

async fn wrap_with_nonce_manager<M: Middleware>(
    provider: M,
    signer_address: Address,
) -> Result<NonceManagerMiddleware<M>, M::Error> {
    let nonce_manager_provider = NonceManagerMiddleware::new(provider, signer_address);
    Ok(nonce_manager_provider)
}

fn build_polygon_gas_oracle(chain: ethers_core::types::Chain) -> ChainResult<Box<dyn GasOracle>> {
    let gas_oracle = Polygon::new(chain)
        .map_err(ChainCommunicationError::from_other)?
        .category(GasCategory::Standard);
    Ok(Box::new(gas_oracle) as Box<dyn GasOracle>)
}

/// Wrap the provider with a gas oracle middleware.
/// Polygon requires using the Polygon gas oracle, see discussion here
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
            _ => Box::new(ProviderOracle::new(provider.clone())),
        }
    };
    Ok(GasOracleMiddleware::new(provider, gas_oracle))
}

fn wrap_with_gas_escalator<M>(provider: M) -> GasEscalatorMiddleware<M>
where
    M: Middleware + 'static,
{
    // Increase the gas price by 12.5% every 90 seconds
    // (These are the default values from ethers doc comments)
    const COEFFICIENT: f64 = 1.125;
    const EVERY_SECS: u64 = 90u64;
    // a 3k gwei limit is chosen to account for `treasure` chain, where the highest gas price observed is 1.2k gwei
    const MAX_GAS_PRICE: u128 = 3_000 * 10u128.pow(9);
    let escalator = GeometricGasPrice::new(COEFFICIENT, EVERY_SECS, MAX_GAS_PRICE.into());
    // Check the status of sent txs every eth block or so. The alternative is to subscribe to new blocks and check then,
    // which adds unnecessary load on the provider.
    const FREQUENCY: Frequency = Frequency::Duration(Duration::from_secs(12).as_millis() as _);
    GasEscalatorMiddleware::new(provider, escalator, FREQUENCY)
}
