use hyperlane_metric::utils::url_to_host_info;
use std::{
    collections::HashMap,
    future::Future,
    ops::Mul,
    sync::{Arc, Mutex as StdMutex, Weak},
    time::{Duration, Instant},
};

use cometbft::{hash::Algorithm, Hash};
use cometbft_rpc::{
    client::CompatMode,
    endpoint::{
        block::Response as BlockResponse, block_results::Response as BlockResultsResponse,
        broadcast::tx_commit, tx::Response as TxResponse,
    },
    Client, Error, HttpClient,
};
use cosmrs::{
    proto::{
        cosmos::{
            auth::v1beta1::{BaseAccount, QueryAccountRequest, QueryAccountResponse},
            bank::v1beta1::{QueryBalanceRequest, QueryBalanceResponse},
            tx::v1beta1::{SimulateRequest, SimulateResponse, TxRaw},
        },
        prost::{self, Message},
    },
    tx::{self, Fee, MessageExt, SignDoc, SignerInfo},
    Any, Coin,
};
use tokio::sync::Mutex;
use tonic::async_trait;
use url::Url;

use hyperlane_core::{
    h512_to_bytes,
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    ChainCommunicationError, ChainResult, FixedPointNumber, H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::{
    ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};

use crate::{ConnectionConf, CosmosAmount, HyperlaneCosmosError, Signer};

const TX_TIMEOUT_BLOCKS: u32 = 100;
const BLOCK_CACHE_TTL: Duration = Duration::from_secs(5);
const BLOCK_CACHE_CAPACITY: usize = 32;

#[derive(Debug)]
struct CachedBlockData {
    fetched_at: Instant,
    data: Arc<BlockData>,
}

#[derive(Debug)]
pub(crate) struct BlockData {
    pub block: BlockResponse,
    pub results: BlockResultsResponse,
}

#[derive(Debug, Default)]
struct SharedBlockCache {
    entries: Mutex<HashMap<u32, Arc<Mutex<Option<CachedBlockData>>>>>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct BlockCacheKey {
    chain_id: String,
    rpc_urls: Vec<String>,
}

static BLOCK_CACHES: once_cell::sync::Lazy<
    StdMutex<HashMap<BlockCacheKey, Weak<SharedBlockCache>>>,
> = once_cell::sync::Lazy::new(|| StdMutex::new(HashMap::new()));

fn shared_block_cache(key: BlockCacheKey) -> Arc<SharedBlockCache> {
    let mut caches = BLOCK_CACHES.lock().expect("block cache mutex poisoned");
    if let Some(cache) = caches.get(&key).and_then(Weak::upgrade) {
        return cache;
    }
    let cache = Arc::new(SharedBlockCache::default());
    caches.insert(key, Arc::downgrade(&cache));
    cache
}

#[derive(Debug)]
pub(crate) struct CosmosHttpClient {
    client: HttpClient,
    metrics: PrometheusClientMetrics,
    metrics_config: PrometheusConfig,
}

/// RPC Provider for Cosmos
///
/// Responsible for chain communication
#[derive(Debug, Clone)]
pub struct RpcProvider {
    provider: FallbackProvider<CosmosHttpClient, CosmosHttpClient>,
    conf: ConnectionConf,
    signer: Option<Signer>,
    gas_price: CosmosAmount,
    block_cache: Arc<SharedBlockCache>,
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
        compat_mode: CompatMode,
    ) -> ChainResult<Self> {
        let tendermint_url = cometbft_rpc::Url::try_from(url.to_owned())
            .map_err(HyperlaneCosmosError::from)
            .map_err(ChainCommunicationError::from_other)?;
        let url = cometbft_rpc::HttpClientUrl::try_from(tendermint_url)
            .map_err(HyperlaneCosmosError::from)
            .map_err(ChainCommunicationError::from_other)?;

        let client = HttpClient::builder(url)
            .compat_mode(compat_mode)
            .build()
            .map_err(HyperlaneCosmosError::from)
            .map_err(ChainCommunicationError::from_other)?;

        Ok(Self::new(client, metrics, metrics_config))
    }
}

impl Clone for CosmosHttpClient {
    fn clone(&self) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.increment_provider_instance(chain_name);

        Self {
            client: self.client.clone(),
            metrics: self.metrics.clone(),
            metrics_config: self.metrics_config.clone(),
        }
    }
}

impl Drop for CosmosHttpClient {
    fn drop(&mut self) {
        // decrement provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.metrics_config.chain);
        self.metrics.decrement_provider_instance(chain_name);
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
        let rpc_urls = conf.get_rpc_urls();
        let clients = rpc_urls
            .iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(url, ClientConnectionType::Rpc, chain.clone());
                CosmosHttpClient::from_url(url, metrics.clone(), metrics_config, conf.compat_mode)
            })
            .collect::<Result<Vec<_>, _>>()?;

        let provider = FallbackProvider::new(clients).with_rpc_context(
            PrometheusConfig::chain_name(&chain).to_owned(),
            "rpcUrls",
            rpc_urls.iter().map(url_to_host_info).collect(),
        );
        let gas_price = CosmosAmount::try_from(conf.get_minimum_gas_price().clone())?;

        let block_cache = shared_block_cache(BlockCacheKey {
            chain_id: conf.get_chain_id(),
            rpc_urls: rpc_urls.iter().map(ToString::to_string).collect(),
        });
        Ok(RpcProvider {
            provider,
            conf,
            signer,
            gas_price,
            block_cache,
        })
    }

    #[cfg(test)]
    pub(crate) fn from_providers(
        provider: Vec<CosmosHttpClient>,
        conf: ConnectionConf,
        signer: Option<Signer>,
        gas_price: CosmosAmount,
    ) -> Self {
        let provider = FallbackProvider::new(provider);
        RpcProvider {
            provider,
            conf,
            signer,
            gas_price,
            block_cache: Arc::new(SharedBlockCache::default()),
        }
    }

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
                "received incorrect transaction, expected hash: {hash:?}, received hash: {received_hash:?}",
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

    /// Fetch block data once when multiple event indexers scan the same height.
    pub(crate) async fn get_block_data(&self, height: u32) -> ChainResult<Arc<BlockData>> {
        let entry = {
            let mut entries = self.block_cache.entries.lock().await;
            if entries.len() >= BLOCK_CACHE_CAPACITY {
                entries.retain(|cached_height, _| height.abs_diff(*cached_height) < 16);
            }
            entries
                .entry(height)
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };
        let mut cached = entry.lock().await;
        if let Some(data) = cached
            .as_ref()
            .filter(|data| data.fetched_at.elapsed() < BLOCK_CACHE_TTL)
        {
            return Ok(data.data.clone());
        }
        let data = self
            .provider
            .call(|client| {
                let future = async move {
                    let (block, results) = tokio::try_join!(
                        Self::track_metric_call(&client, "get_block", || {
                            client.client.block(height)
                        }),
                        Self::track_metric_call(&client, "block_results", || {
                            client.client.block_results(height)
                        }),
                    )?;
                    if results.height.value() != u64::from(height)
                        || block.block.header.height.value() != u64::from(height)
                    {
                        return Err(ChainCommunicationError::from_other_str(
                            "Block data height does not match the requested block",
                        ));
                    }
                    Ok(Arc::new(BlockData { block, results }))
                };
                Box::pin(future)
            })
            .await?;
        *cached = Some(CachedBlockData {
            fetched_at: Instant::now(),
            data: data.clone(),
        });
        Ok(data)
    }

    /// abci query is low level function that only gets called by higher level ones like 'get_balance'
    /// it performs raw state queries on the cosmos sdk
    async fn abci_query<T, R>(&self, path: &str, request: T) -> ChainResult<R>
    where
        T: Message + prost::Name,
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
        account_from_response(response)
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
        let account_info = self.get_account(signer.address_string.clone()).await?;

        let current_height = self.get_block_number().await? as u32;

        let tx_body = tx::Body::new(
            msgs,
            String::default(),
            current_height.saturating_add(TX_TIMEOUT_BLOCKS),
        );
        let signer_info = SignerInfo::single_direct(Some(signer.public_key), account_info.sequence);

        let amount: u128 = (FixedPointNumber::from(gas_limit).mul(self.gas_price()))
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

        let gas_multiplier = self.conf.get_gas_multiplier().max(2.0);
        let gas_estimate = (gas_used as f64 * gas_multiplier).ceil() as u64;

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

/// Injective's `injective.types.v1beta1.EthAccount`, which wraps the Cosmos SDK `BaseAccount`.
#[derive(Clone, PartialEq, prost::Message)]
struct InjectiveEthAccount {
    #[prost(message, optional, tag = "1")]
    base_account: Option<BaseAccount>,
    #[prost(bytes = "vec", tag = "2")]
    code_hash: Vec<u8>,
}

/// Decodes the `BaseAccount` wrapped by Injective's `injective.types.v1beta1.EthAccount`.
fn decode_injective_base_account(bytes: &[u8]) -> ChainResult<BaseAccount> {
    let eth_account = InjectiveEthAccount::decode(bytes).map_err(HyperlaneCosmosError::from)?;
    Ok(eth_account.base_account.unwrap_or_default())
}

/// Decodes the account in an auth `Query/Account` response, falling back to Injective's
/// `EthAccount` when it is not a standard `BaseAccount`.
fn account_from_response(response: QueryAccountResponse) -> ChainResult<BaseAccount> {
    let account = response
        .account
        .ok_or_else(|| ChainCommunicationError::from_other_str("account not present"))?;
    BaseAccount::decode(account.value.as_slice())
        .or_else(|_| decode_injective_base_account(account.value.as_slice()))
}

#[cfg(test)]
mod injective_account_tests {
    use super::*;

    fn sample_base_account() -> BaseAccount {
        let mut pub_key = vec![0x0a, 0x21, 0x02];
        pub_key.extend_from_slice(&[0x5c; 32]);
        BaseAccount {
            address: "inj1qqqsyqcyq5rqwzqfpg9scrgwpugpzysn8u4wfk".to_owned(),
            pub_key: Some(Any {
                type_url: "/injective.crypto.v1beta1.ethsecp256k1.PubKey".to_owned(),
                value: pub_key,
            }),
            account_number: 42,
            sequence: 7,
        }
    }

    /// Wire encoding of `injective.types.v1beta1.EthAccount`
    /// (`base_account = 1`, `code_hash = 2`), built by hand so the expected
    /// bytes do not come from the decoder's own message definition.
    fn eth_account_bytes(base_account: Option<&BaseAccount>, code_hash: &[u8]) -> Vec<u8> {
        fn push_length_delimited(bytes: &mut Vec<u8>, tag: u8, value: &[u8]) {
            bytes.push(tag);
            let mut len = value.len();
            while len >= 0x80 {
                bytes.push((len & 0x7f) as u8 | 0x80);
                len >>= 7;
            }
            bytes.push(len as u8);
            bytes.extend_from_slice(value);
        }

        let mut bytes = Vec::new();
        if let Some(base_account) = base_account {
            push_length_delimited(&mut bytes, 0x0a, &base_account.encode_to_vec());
        }
        push_length_delimited(&mut bytes, 0x12, code_hash);
        bytes
    }

    #[test]
    fn decodes_base_account_wrapped_in_eth_account() {
        let base_account = sample_base_account();
        let bytes = eth_account_bytes(Some(&base_account), &[0xc5; 32]);

        let decoded = decode_injective_base_account(&bytes).expect("valid EthAccount");

        assert_eq!(decoded, base_account);
    }

    #[test]
    fn eth_account_without_base_account_decodes_to_default() {
        let bytes = eth_account_bytes(None, &[0xc5; 32]);

        let decoded = decode_injective_base_account(&bytes).expect("valid EthAccount");

        assert_eq!(decoded, BaseAccount::default());
    }

    #[test]
    fn account_response_falls_back_to_injective_eth_account() {
        // keccak256 of empty code, the code hash of accounts without contract code.
        let empty_code_hash =
            hex::decode("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
                .expect("valid hex");
        let base_account = sample_base_account();
        let eth_account = eth_account_bytes(Some(&base_account), &empty_code_hash);
        // Not a valid standard `BaseAccount`, so this takes the Injective fallback.
        assert!(BaseAccount::decode(eth_account.as_slice()).is_err());
        let response = QueryAccountResponse {
            account: Some(Any {
                type_url: "/injective.types.v1beta1.EthAccount".to_owned(),
                value: eth_account,
            }),
        }
        .encode_to_vec();

        // `abci_query` decodes the response before `get_account` reads the account from it.
        let response = QueryAccountResponse::decode(response.as_slice()).expect("valid response");
        let account = account_from_response(response).expect("Injective account");

        assert_eq!(account.account_number, 42);
        assert_eq!(account.sequence, 7);
        assert_eq!(account, base_account);
    }

    #[test]
    fn account_response_decodes_standard_base_account() {
        let base_account = sample_base_account();
        let response = QueryAccountResponse {
            account: Some(Any {
                type_url: "/cosmos.auth.v1beta1.BaseAccount".to_owned(),
                value: base_account.encode_to_vec(),
            }),
        };

        let account = account_from_response(response).expect("base account");

        assert_eq!(account, base_account);
    }

    #[test]
    fn missing_account_is_an_error() {
        let error =
            account_from_response(QueryAccountResponse { account: None }).expect_err("no account");

        assert!(error.to_string().contains("account not present"));
    }

    #[test]
    fn undecodable_account_is_an_error() {
        // Field 1 declares 16 bytes that are missing, so both decoders reject it.
        let value = vec![0x0a, 0x10];
        assert!(BaseAccount::decode(value.as_slice()).is_err());
        assert!(decode_injective_base_account(&value).is_err());
        let response = QueryAccountResponse {
            account: Some(Any {
                type_url: "/injective.types.v1beta1.EthAccount".to_owned(),
                value,
            }),
        };

        assert!(account_from_response(response).is_err());
    }

    #[test]
    fn truncated_eth_account_is_rejected() {
        let base_account = sample_base_account();
        let bytes = eth_account_bytes(Some(&base_account), &[]);
        // The encoding ends with `base_account.sequence` (field 4) and the empty
        // `code_hash` (field 2). Cutting both leaves `base_account` shorter than
        // its declared length; it must not decode as an account with sequence 0.
        assert_eq!(bytes[bytes.len() - 4..], [0x20, 0x07, 0x12, 0x00]);
        let truncated = &bytes[..bytes.len() - 4];

        assert!(decode_injective_base_account(truncated).is_err());
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[tokio::test]
    async fn rpc_transport_errors_omit_endpoint_credentials() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let address = listener.local_addr().expect("test address");
        drop(listener);
        let url = Url::parse(&format!("http://{address}/private-path?key=private-query"))
            .expect("test URL");
        let client = CosmosHttpClient::from_url(
            &url,
            Default::default(),
            Default::default(),
            CompatMode::V0_38,
        )
        .expect("test client");
        let raw_error = client
            .client
            .latest_block()
            .await
            .expect_err("connection failure");
        assert!(format!("{raw_error:?}").contains("private-"));
        let error = HyperlaneCosmosError::from(Box::new(raw_error));
        assert!(matches!(error, HyperlaneCosmosError::RpcTransportError(_)));
        assert!(error.to_string().contains("Connection refused"));
        assert!(!format!("{error:?} {error}").contains("private-"));
        let error = client
            .get_block_number()
            .await
            .expect_err("connection failure");
        assert!(error.to_string().contains("Connection refused"));
        assert!(!format!("{error:?} {error}").contains("private-"));

        let url = Url::parse("ws://localhost/private-path?key=private-query").expect("test URL");
        let error = CosmosHttpClient::from_url(
            &url,
            Default::default(),
            Default::default(),
            CompatMode::V0_38,
        )
        .expect_err("HTTP client rejects WebSocket URL");
        assert!(!format!("{error:?} {error}").contains("private-"));
    }

    #[test]
    fn block_caches_are_scoped_to_rpc_endpoints() {
        let key = BlockCacheKey {
            chain_id: "shared-chain-id".to_owned(),
            rpc_urls: vec!["http://chain-a".to_owned()],
        };
        let first = shared_block_cache(key.clone());
        let same = shared_block_cache(key);
        let other = shared_block_cache(BlockCacheKey {
            chain_id: "shared-chain-id".to_owned(),
            rpc_urls: vec!["http://chain-b".to_owned()],
        });

        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &other));
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
