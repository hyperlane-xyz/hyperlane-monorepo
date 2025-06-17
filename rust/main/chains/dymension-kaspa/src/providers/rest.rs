use std::future::Future;
use std::time::Instant;

use cosmrs::{
    proto::cosmos::{
        auth::v1beta1::{BaseAccount, QueryAccountRequest, QueryAccountResponse},
        bank::v1beta1::{QueryBalanceRequest, QueryBalanceResponse},
        tx::v1beta1::{SimulateRequest, SimulateResponse, TxRaw},
    },
    rpc::HttpClient,
    tx::{self, Fee, MessageExt, SignDoc, SignerInfo},
    Any, Coin,
};
use hyperlane_cosmos_rs::prost::Message;
use tendermint::{hash::Algorithm, Hash};
use tendermint_rpc::{
    client::CompatMode,
    endpoint::{
        block::Response as BlockResponse, block_results::Response as BlockResultsResponse,
        broadcast::tx_commit, tx::Response as TxResponse,
    },
    Client, Error,
};
use tonic::async_trait;

use hyperlane_core::{
    h512_to_bytes,
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    ChainCommunicationError, ChainResult, FixedPointNumber, H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use url::Url;

use crate::{ConnectionConf, HyperlaneKaspaError, KaspaAmount, Signer};

use super::kaspa::KaspaFallbackProvider;

#[derive(Debug)]
struct KaspaHttpClient {
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
}

#[derive(Debug, Clone)]
pub struct RestProvider {
    client: KaspaHttpClient,
    conf: ConnectionConf,
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
    pub fn new(metrics: PrometheusClientMetrics, metrics_config: PrometheusConfig) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&metrics_config.chain);
        metrics.increment_provider_instance(chain_name);

        Self {
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
        Ok(Self::new(metrics, metrics_config))
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

    // mostly copy pasted from `hyperlane-kaspa/src/providers/rpc/client.rs`
    async fn track_metric_call<F, Fut, T>(
        client: &KaspaHttpClient,
        method: &str,
        call: F,
    ) -> ChainResult<T>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<T, Error>>,
    {
        let start = Instant::now();
        let res = call().await;

        client
            .metrics
            .increment_metrics(&client.metrics_config, method, start, res.is_ok());

        res.map_err(|e| ChainCommunicationError::from(HyperlaneKaspaError::from(e)))
    }

    /// Get the transaction by hash
    pub async fn get_tx(&self, hash: &H512) -> ChainResult<TxResponse> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }

    /// Get the block by height
    pub async fn get_block(&self, height: u32) -> ChainResult<BlockResponse> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }

    /// Get the block results by height
    pub async fn get_block_results(&self, height: u32) -> ChainResult<BlockResultsResponse> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }

    /// Returns the denom balance of that address. Will use the denom specified as the canonical asset in the config
    pub async fn get_balance(&self, address: String) -> ChainResult<U256> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
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
}

impl RestProvider {
}