use hyperlane_core::{
    rpc_clients::BlockNumberGetter, ChainCommunicationError, ChainResult, FixedPointNumber,
};
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use tonic::async_trait;

use dym_kas_api::apis::configuration::Configuration;
pub use dym_kas_core::api::base::{get_config, RateLimitConfig};
pub use dym_kas_core::api::client::*;

use crate::ConnectionConf;
use hyperlane_cosmos_native::Signer;

#[derive(Debug)]
pub struct KaspaHttpClient {
    pub client: HttpClient,
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
}

#[derive(Debug, Clone)]
pub struct RestProvider {
    pub client: KaspaHttpClient,
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
        url: String,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
    ) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&metrics_config.chain);
        metrics.increment_provider_instance(chain_name);

        Self {
            client: HttpClient::new(url, RateLimitConfig::default()),
            metrics,
            metrics_config,
        }
    }

    /// Creates a KaspaHttpClient from a url
    pub fn from_url(
        url: String,
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
        Self::new(
            self.client.url.clone(),
            self.metrics.clone(),
            self.metrics_config.clone(),
        )
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
        let clients = [conf.clone().kaspa_rest_url]
            .iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(url, ClientConnectionType::Rpc, chain.clone());
                KaspaHttpClient::from_url(url.to_string(), metrics.clone(), metrics_config)
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(RestProvider {
            client: clients[0].clone(),
            signer,
        })
    }

    /// get the config used for the rest client
    pub fn get_config(&self) -> Configuration {
        self.client.client.get_config()
    }

    /// Gets a signer, or returns an error if one is not available.
    pub fn get_signer(&self) -> ChainResult<&Signer> {
        self.signer
            .as_ref()
            .ok_or(ChainCommunicationError::SignerUnavailable)
    }

    /// Get the gas price
    pub fn gas_price(&self) -> FixedPointNumber {
        FixedPointNumber::zero()
    }

    /// dococo
    pub async fn get_deposits(
        &self,
        escrow_addr: &str,
        lower_bound_unix_time: Option<i64>,
    ) -> ChainResult<Vec<Deposit>> {
        let res = self
            .client
            .client
            .get_deposits_by_address(lower_bound_unix_time, escrow_addr)
            .await;
        res.map_err(|e| ChainCommunicationError::from_other_str(&e.to_string()))
            .map(|deposits| deposits.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use url::Url;

    #[test]
    fn test_url_roundtrip() {
        let start = "https://api-tn10.kaspa.org/";
        let url = Url::parse(start).unwrap();
        let end = url.as_str();
        assert_eq!(start, end);
    }
}
