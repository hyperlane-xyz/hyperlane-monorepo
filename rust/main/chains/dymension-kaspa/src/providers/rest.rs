use std::future::Future;
use std::time::Instant;

use tonic::async_trait;

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult, FixedPointNumber, H512,
    U256,
};
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use url::Url;

use dym_kas_core::api::deposits::*;

use crate::{ConnectionConf, HyperlaneKaspaError, Signer};

use dym_kas_core::api::deposits::*;

pub use dym_kas_core::api::deposits::*;

#[derive(Debug)]
struct KaspaHttpClient {
    client: HttpClient,
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
}

#[derive(Debug, Clone)]
pub struct RestProvider {
    client: KaspaHttpClient,
    pub conf: ConnectionConf,
    signer: Option<Signer>,
}

#[async_trait]
impl BlockNumberGetter for KaspaHttpClient {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}

impl KaspaHttpClient {
    /// Create new `KaspaHttpClient`
    pub fn new(
        url: Url,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
    ) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&metrics_config.chain);
        metrics.increment_provider_instance(chain_name);

        Self {
            client: HttpClient::new(url),
            metrics,
            metrics_config,
        }
    }

    /// Creates a KaspaHttpClient from a url
    pub fn from_url(
        url: &Url,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
    ) -> ChainResult<Self> {
        Ok(Self::new(url, metrics, metrics_config))
    }
}

impl Drop for KaspaHttpClient {
    fn drop(&mut self) {
        // decrement provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.decrement_provider_instance(chain_name);
    }
}

impl Clone for KaspaHttpClient {
    fn clone(&self) -> Self {
        Self::new(self.metrics.clone(), self.metrics_config.clone())
    }
}

#[async_trait]
impl BlockNumberGetter for RestProvider {
    async fn get_block_number(&self) -> ChainResult<u64> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}

impl RestProvider {
    /// Returns a new Rpc Provider
    pub fn new(
        conf: ConnectionConf,
        signer: Option<Signer>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
    ) -> ChainResult<Self> {
        let url = vec![Url::parse("http://localhost:16200").unwrap()];
        let clients = url
            .iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(url, ClientConnectionType::Rpc, chain.clone());
                KaspaHttpClient::from_url(url, metrics.clone(), metrics_config)
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(RestProvider {
            client: clients[0].clone(),
            conf,
            signer,
        })
    }

    /// Gets a signer, or returns an error if one is not available.
    pub fn get_signer(&self) -> ChainResult<&Signer> {
        self.signer
            .as_ref()
            .ok_or(ChainCommunicationError::SignerUnavailable)
    }

    /// Get the gas price
    pub fn gas_price(&self) -> FixedPointNumber {
        return FixedPointNumber::zero();
    }

    pub fn get_deposits(&self) -> ChainResult<Vec<Deposit>> {
        let address = self.conf.escrow_address.clone();
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}
