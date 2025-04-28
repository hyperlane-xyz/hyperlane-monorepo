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

use crate::{ConnectionConf, CosmosAmount, HyperlaneCosmosError, Signer};

use super::cosmos::CosmosFallbackProvider;

#[derive(Debug)]
struct CosmosHttpClient {
    client: HttpClient,
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
}

/// RPC Provider for Cosmos
///
/// Responsible for chain communication
#[derive(Debug, Clone)]
pub struct RpcProvider {
    provider: CosmosFallbackProvider<CosmosHttpClient>,
    conf: ConnectionConf,
    signer: Option<Signer>,
    gas_price: CosmosAmount,
}

#[async_trait]
impl BlockNumberGetter for CosmosHttpClient {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        let block = self
            .client
            .latest_block()
            .await
            .map_err(HyperlaneCosmosError::from)?;

        Ok(block.block.header.height.value())
    }
}

impl CosmosHttpClient {
    /// Create new `CosmosHttpClient`
    pub fn new(
        client: HttpClient,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
    ) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&metrics_config.chain);
        metrics.increment_provider_instance(chain_name);

        Self {
            client,
            metrics,
            metrics_config,
        }
    }

    /// Creates a CosmosHttpClient from a url
    pub fn from_url(
        url: &Url,
        metrics: PrometheusClientMetrics,
        metrics_config: PrometheusConfig,
    ) -> ChainResult<Self> {
        let tendermint_url = tendermint_rpc::Url::try_from(url.to_owned())
            .map_err(Box::new)
            .map_err(ChainCommunicationError::from_other)?;
        let url = tendermint_rpc::HttpClientUrl::try_from(tendermint_url)
            .map_err(Box::new)
            .map_err(ChainCommunicationError::from_other)?;

        let client = HttpClient::builder(url)
            // Consider supporting different compatibility modes.
            .compat_mode(CompatMode::latest())
            .build()
            .map_err(Box::new)
            .map_err(ChainCommunicationError::from_other)?;

        Ok(Self::new(client, metrics, metrics_config))
    }
}

impl Drop for CosmosHttpClient {
    fn drop(&mut self) {
        // decrement provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.decrement_provider_instance(chain_name);
    }
}

impl Clone for CosmosHttpClient {
    fn clone(&self) -> Self {
        Self::new(
            self.client.clone(),
            self.metrics.clone(),
            self.metrics_config.clone(),
        )
    }
}

impl RpcProvider {
    /// Returns a new Rpc Provider
    pub fn new(
        conf: ConnectionConf,
        signer: Option<Signer>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
    ) -> ChainResult<Self> {
        let clients = conf
            .get_rpc_urls()
            .iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(url, ClientConnectionType::Rpc, chain.clone());
                CosmosHttpClient::from_url(url, metrics.clone(), metrics_config)
            })
            .collect::<Result<Vec<_>, _>>()?;

        let provider = FallbackProvider::new(clients);
        let provider = CosmosFallbackProvider::new(provider);
        let gas_price = CosmosAmount::try_from(conf.get_minimum_gas_price().clone())?;

        Ok(RpcProvider {
            provider,
            conf,
            signer,
            gas_price,
        })
    }

    // mostly copy pasted from `hyperlane-cosmos/src/providers/rpc/client.rs`
    async fn track_metric_call<F, Fut, T>(
        client: &CosmosHttpClient,
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

        res.map_err(|e| ChainCommunicationError::from(HyperlaneCosmosError::from(e)))
    }

    /// Get the transaction by hash
    pub async fn get_tx(&self, hash: &H512) -> ChainResult<TxResponse> {
        let hash: H256 = H256::from_slice(&h512_to_bytes(hash));

        let tendermint_hash = Hash::from_bytes(Algorithm::Sha256, hash.as_bytes())
            .expect("transaction hash should be of correct size");

        let response = self
            .provider
            .call(|client| {
                let future = async move {
                    Self::track_metric_call(&client, "get_tx", || {
                        client.client.tx(tendermint_hash, false)
                    })
                    .await
                };
                Box::pin(future)
            })
            .await?;

        let received_hash = H256::from_slice(response.hash.as_bytes());
        if received_hash != hash {
            return Err(ChainCommunicationError::from_other_str(&format!(
                "received incorrect transaction, expected hash: {:?}, received hash: {:?}",
                hash, received_hash,
            )));
        }

        Ok(response)
    }

    /// Get the block by height
    pub async fn get_block(&self, height: u32) -> ChainResult<BlockResponse> {
        self.provider
            .call(|client| {
                let future = async move {
                    Self::track_metric_call(&client, "get_block", || client.client.block(height))
                        .await
                };
                Box::pin(future)
            })
            .await
    }

    /// Get the block results by height
    pub async fn get_block_results(&self, height: u32) -> ChainResult<BlockResultsResponse> {
        self.provider
            .call(|client| {
                let future = async move {
                    Self::track_metric_call(&client, "block_results", || {
                        client.client.block_results(height)
                    })
                    .await
                };
                Box::pin(future)
            })
            .await
    }

    /// abci query is low level function that only gets called by higher level ones like 'get_balance'
    /// it performs raw state queries on the cosmos sdk
    async fn abci_query<T, R>(&self, path: &str, request: T) -> ChainResult<R>
    where
        T: Message + hyperlane_cosmos_rs::prost::Name,
        R: Message + std::default::Default,
    {
        let bytes = request.encode_to_vec();
        let response = self
            .provider
            .call(|client| {
                let path = path.to_owned();
                let bytes = bytes.clone();
                let future = async move {
                    Self::track_metric_call(&client, T::NAME, || {
                        client
                            .client
                            .abci_query(Some(path.to_owned()), bytes.clone(), None, false)
                    })
                    .await
                };
                Box::pin(future)
            })
            .await?;

        if response.code.is_err() {
            return Err(ChainCommunicationError::from_other_str(&format!(
                "ABCI query failed: path={}, code={}, log={}",
                path,
                response.code.value(),
                response.log
            )));
        }

        let response = R::decode(response.value.as_slice()).map_err(HyperlaneCosmosError::from)?;
        Ok(response)
    }

    /// Returns the denom balance of that address. Will use the denom specified as the canonical asset in the config
    pub async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let response: QueryBalanceResponse = self
            .abci_query(
                "/cosmos.bank.v1beta1.Query/Balance",
                QueryBalanceRequest {
                    address,
                    denom: self.conf.get_canonical_asset(),
                },
            )
            .await?;
        let balance = response
            .balance
            .ok_or_else(|| ChainCommunicationError::from_other_str("account not present"))?;

        Ok(U256::from_dec_str(&balance.amount)?)
    }

    /// Gets a signer, or returns an error if one is not available.
    pub fn get_signer(&self) -> ChainResult<&Signer> {
        self.signer
            .as_ref()
            .ok_or(ChainCommunicationError::SignerUnavailable)
    }

    async fn get_account(&self, address: String) -> ChainResult<BaseAccount> {
        let response: QueryAccountResponse = self
            .abci_query(
                "/cosmos.auth.v1beta1.Query/Account",
                QueryAccountRequest { address },
            )
            .await?;
        let account = BaseAccount::decode(
            response
                .account
                .ok_or_else(|| ChainCommunicationError::from_other_str("account not present"))?
                .value
                .as_slice(),
        )
        .map_err(HyperlaneCosmosError::from)?;
        Ok(account)
    }

    /// Get the gas price
    pub fn gas_price(&self) -> FixedPointNumber {
        self.gas_price.amount.clone()
    }

    /// Generates an unsigned SignDoc for a transaction and the Coin amount
    /// required to pay for tx fees.
    async fn generate_sign_doc(
        &self,
        msgs: Vec<cosmrs::Any>,
        gas_limit: u64,
    ) -> ChainResult<SignDoc> {
        // As this function is only used for estimating gas or sending transactions,
        // we can reasonably expect to have a signer.
        let signer = self.get_signer()?;
        let account_info = self.get_account(signer.address.clone()).await?;

        // timeout height of zero means that we do not have a timeout height TODO: double check
        let tx_body = tx::Body::new(msgs, String::default(), 0u32);
        let signer_info = SignerInfo::single_direct(Some(signer.public_key), account_info.sequence);

        let amount: u128 = (FixedPointNumber::from(gas_limit) * self.gas_price())
            .ceil_to_integer()
            .try_into()?;
        let fee_coin = Coin::new(
            // The fee to pay is the gas limit * the gas price
            amount,
            self.conf.get_canonical_asset().as_str(),
        )
        .map_err(HyperlaneCosmosError::from)?;

        let auth_info =
            signer_info.auth_info(Fee::from_amount_and_gas(fee_coin.clone(), gas_limit));

        let chain_id = self
            .conf
            .get_chain_id()
            .parse()
            .map_err(HyperlaneCosmosError::from)?;

        Ok(
            SignDoc::new(&tx_body, &auth_info, &chain_id, account_info.account_number)
                .map_err(HyperlaneCosmosError::from)?,
        )
    }

    /// Estimates the gas that will be used when a transaction with msgs is sent.
    ///
    /// Note: that simulated result will be multiplied by the gas multiplier in the gas config
    pub async fn estimate_gas(&self, msgs: Vec<Any>) -> ChainResult<u64> {
        // Get a sign doc with 0 gas, because we plan to simulate
        let sign_doc = self.generate_sign_doc(msgs, 0).await?;

        let raw_tx = TxRaw {
            body_bytes: sign_doc.body_bytes,
            auth_info_bytes: sign_doc.auth_info_bytes,
            signatures: vec![vec![]],
        };
        let tx_bytes = raw_tx
            .to_bytes()
            .map_err(ChainCommunicationError::from_other)?;

        #[allow(deprecated)]
        let response: SimulateResponse = self
            .abci_query(
                "/cosmos.tx.v1beta1.Service/Simulate",
                SimulateRequest { tx_bytes, tx: None },
            )
            .await?;

        let gas_used = response
            .gas_info
            .ok_or(ChainCommunicationError::from_other_str(
                "gas info not present",
            ))?
            .gas_used;

        let gas_estimate = (gas_used as f64 * self.conf.get_gas_multiplier()) as u64;

        Ok(gas_estimate)
    }

    /// Sends a transaction and waits for confirmation
    ///
    /// gas_limit will be automatically set if None is passed
    pub async fn send(
        &self,
        msgs: Vec<Any>,
        gas_limit: Option<u64>,
    ) -> ChainResult<tx_commit::Response> {
        let gas_limit = match gas_limit {
            Some(limit) => limit,
            None => self.estimate_gas(msgs.clone()).await?,
        };

        let sign_doc = self.generate_sign_doc(msgs, gas_limit).await?;
        let signer = self.get_signer()?;

        let signed_tx = sign_doc
            .sign(&signer.signing_key()?)
            .map_err(HyperlaneCosmosError::from)?;
        let signed_tx = signed_tx.to_bytes()?;

        // broadcast tx commit blocks until the tx is included in a block
        self.provider
            .call(|client| {
                let signed_tx = signed_tx.clone(); // TODO: this is very memory inefficient, we should actually be able to just reference the slice
                let future = async move {
                    Self::track_metric_call(&client, "send", || {
                        client.client.broadcast_tx_commit(signed_tx.clone())
                    })
                    .await
                };
                Box::pin(future)
            })
            .await
    }
}

#[async_trait]
impl BlockNumberGetter for RpcProvider {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        self.provider
            .call(|client| {
                let future = async move { client.get_block_number().await };
                Box::pin(future)
            })
            .await
    }
}
