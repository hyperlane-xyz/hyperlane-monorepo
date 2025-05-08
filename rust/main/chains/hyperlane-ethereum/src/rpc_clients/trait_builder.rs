use std::fmt::Debug;
use std::str::FromStr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use dashmap::DashMap;
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
use hyperlane_metric::utils::url_to_host_info;
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::{Client, Url};
use thiserror::Error;

use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, PrometheusJsonRpcClient};
use ethers_prometheus::middleware::{MiddlewareMetrics, PrometheusMiddlewareConf};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneDomain, KnownHyperlaneDomain,
};
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, NodeInfo, PrometheusClientMetrics, PrometheusClientMetricsBuilder,
    PrometheusConfig,
};
use tracing::instrument;

use crate::signer::Signers;
use crate::tx::PENDING_TX_TIMEOUT_SECS;
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

    /// Whether this provider requires submission middleware such as gas oracle,
    /// gas escalator, nonce manager. It defaults to true, since it's only Lander
    /// that doesn't require it.
    const USES_ETHERS_SUBMISSION_MIDDLEWARE: bool = true;

    /// Construct a new instance of the associated trait using a connection
    /// config. This is the first step and will wrap the provider with
    /// metrics and a signer as needed.
    async fn build_with_connection_conf(
        &self,
        conn: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<Signers>,
        client_metrics: Option<PrometheusClientMetrics>,
        middleware_metrics: Option<(MiddlewareMetrics, PrometheusMiddlewareConf)>,
    ) -> ChainResult<Self::Output> {
        Ok(match &conn.rpc_connection {
            RpcConnectionConf::HttpQuorum { urls } => {
                let mut builder = QuorumProvider::builder().quorum(Quorum::Majority);
                for url in urls {
                    let http_provider = build_http_provider(url.clone())?;
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
                        &client_metrics,
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
                for url in urls {
                    let http_provider = build_http_provider(url.clone())?;
                    let metrics_provider = self.wrap_rpc_with_metrics(
                        http_provider,
                        url.clone(),
                        &client_metrics,
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
                let http_provider = build_http_provider(url.clone())?;
                let metrics_provider = self.wrap_rpc_with_metrics(
                    http_provider,
                    url.clone(),
                    &client_metrics,
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
        client_metrics: &Option<PrometheusClientMetrics>,
        middleware_metrics: &Option<(MiddlewareMetrics, PrometheusMiddlewareConf)>,
    ) -> PrometheusJsonRpcClient<C> {
        PrometheusJsonRpcClient::new(
            client,
            client_metrics
                .clone()
                .unwrap_or_else(|| PrometheusClientMetricsBuilder::default().build().unwrap()),
            PrometheusConfig {
                connection_type: ClientConnectionType::Rpc,
                node: Some(NodeInfo {
                    host: url_to_host_info(&url),
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
        let Some(signer) = signer else {
            return Ok(self.build_with_provider(provider, conn, locator).await);
        };
        let signing_provider = wrap_with_signer(provider, signer.clone())
            .await
            .map_err(ChainCommunicationError::from_other)?;

        if !Self::USES_ETHERS_SUBMISSION_MIDDLEWARE {
            // don't wrap the signing provider in any middlewares
            return Ok(self
                .build_with_provider(signing_provider, conn, locator)
                .await);
        }

        let gas_escalator_provider = wrap_with_gas_escalator(signing_provider);
        let gas_oracle_provider = wrap_with_gas_oracle(gas_escalator_provider, locator.domain)?;
        let nonce_manager_provider = wrap_with_nonce_manager(gas_oracle_provider, signer.address())
            .await
            .map_err(ChainCommunicationError::from_other)?;

        Ok(self
            .build_with_provider(nonce_manager_provider, conn, locator)
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
    // Increase the gas price by 25% every 90 seconds
    const COEFFICIENT: f64 = 1.125;

    // escalating creates a new tx hash, and the submitter tracks each tx hash for at most
    // `PENDING_TX_TIMEOUT_SECS`. So the escalator will send a new tx when the initial
    // tx hash stops being tracked.
    const EVERY_SECS: u64 = PENDING_TX_TIMEOUT_SECS;
    // a 50k gwei limit is chosen to account for `treasure` chain, where the highest gas price observed is 1.2k gwei
    const MAX_GAS_PRICE: u128 = 3_000 * 10u128.pow(9);
    let escalator = GeometricGasPrice::new(COEFFICIENT, EVERY_SECS, MAX_GAS_PRICE.into());
    // Check the status of sent txs every eth block or so. The alternative is to subscribe to new blocks and check then,
    // which adds unnecessary load on the provider.
    const FREQUENCY: Frequency = Frequency::Duration(Duration::from_secs(12).as_millis() as _);
    GasEscalatorMiddleware::new(provider, escalator, FREQUENCY)
}

/// Builds a new HTTP provider with the given URL.
fn build_http_provider(url: Url) -> ChainResult<Http> {
    let client = get_reqwest_client(&url)?;
    Ok(Http::new_with_client(url, client))
}

/// Gets a cached reqwest client for the given URL, or builds a new one if it doesn't exist.
fn get_reqwest_client(url: &Url) -> ChainResult<Client> {
    let client_cache = get_reqwest_client_cache();
    if let Some(client) = client_cache.get(url) {
        return Ok(client.clone());
    }
    let client = build_new_reqwest_client(url.clone())?;
    client_cache.insert(url.clone(), client.clone());
    Ok(client)
}

/// Builds a new reqwest client with the given URL.
/// Generally `get_reqwest_client` should be used instead of this function,
/// as it caches the client for reuse.
fn build_new_reqwest_client(url: Url) -> ChainResult<Client> {
    let mut queries_to_keep = vec![];
    let mut headers = reqwest::header::HeaderMap::new();

    // A hack to pass custom headers to the provider without
    // requiring a bunch of changes to our configuration surface area.
    // Any `custom_rpc_header` query parameter is expected to have the value
    // format: `header_name:header_value`, will be added to the headers
    // of the HTTP client, and removed from the URL params.
    let mut updated_url = url.clone();
    for (key, value) in url.query_pairs() {
        if key != "custom_rpc_header" {
            queries_to_keep.push((key.clone(), value.clone()));
            continue;
        }
        if let Some((header_name, header_value)) = value.split_once(':') {
            let header_name =
                HeaderName::from_str(header_name).map_err(ChainCommunicationError::from_other)?;
            let mut header_value =
                HeaderValue::from_str(header_value).map_err(ChainCommunicationError::from_other)?;
            header_value.set_sensitive(true);
            headers.insert(header_name, header_value);
        }
    }

    updated_url
        .query_pairs_mut()
        .clear()
        .extend_pairs(queries_to_keep);

    let client = Client::builder()
        .timeout(HTTP_CLIENT_TIMEOUT)
        .default_headers(headers)
        .build()
        .map_err(EthereumProviderConnectionError::from)?;

    Ok(client)
}

/// A cache for reqwest clients, indexed by URL.
/// Generally creating a new Reqwest client is expensive due to some DNS
/// resolutions, so we cache them for reuse.
static REQWEST_CLIENT_CACHE: OnceLock<DashMap<Url, Client>> = OnceLock::new();

fn get_reqwest_client_cache() -> &'static DashMap<Url, Client> {
    REQWEST_CLIENT_CACHE.get_or_init(DashMap::new)
}
