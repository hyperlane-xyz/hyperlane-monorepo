//! A wrapper around a JsonRpcClient to give insight at the request level. This
//! was designed specifically for use with the quorum provider.

use std::{
    collections::HashMap,
    fmt::{Debug, Formatter},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use derive_new::new;
use ethers::prelude::JsonRpcClient;
use ethers_core::types::U64;
use hyperlane_core::rpc_clients::BlockNumberGetter;
use hyperlane_core::ChainResult;
use hyperlane_metric::prometheus_metric::{
    PrometheusClientMetrics, PrometheusConfig, PrometheusConfigExt,
};
use parking_lot::Mutex;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

const FINALIZED_BLOCK_CACHE_TTL: Duration = Duration::from_millis(250);
const GET_BLOCK_BY_NUMBER_RPC: &str = "eth_getBlockByNumber";
const DYNAMIC_BLOCK_TAGS: &[&str] = &["latest", "safe", "finalized"];

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum DynamicBlockMethod {
    BlockNumber,
    GetBlockByNumber,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RequestCacheKey {
    method: DynamicBlockMethod,
    params: Vec<u8>,
}

struct EndpointRequestCache {
    responses: Mutex<HashMap<RequestCacheKey, (Instant, Value)>>,
    singleflight: Mutex<HashMap<RequestCacheKey, Arc<AsyncMutex<()>>>>,
    ttl: Duration,
}

impl EndpointRequestCache {
    fn new(ttl: Duration) -> Self {
        Self {
            responses: Mutex::new(HashMap::new()),
            singleflight: Mutex::new(HashMap::new()),
            ttl,
        }
    }

    fn get(&self, key: &RequestCacheKey) -> Option<Value> {
        let mut responses = self.responses.lock();
        let (inserted_at, response) = responses.get(key)?;
        if Instant::now().saturating_duration_since(*inserted_at) < self.ttl {
            return Some(response.clone());
        }
        responses.remove(key);
        None
    }

    fn insert(&self, key: RequestCacheKey, response: Value) {
        self.responses
            .lock()
            .insert(key, (Instant::now(), response));
    }

    fn remove(&self, key: &RequestCacheKey) {
        self.responses.lock().remove(key);
    }

    fn singleflight(&self, key: &RequestCacheKey) -> Arc<AsyncMutex<()>> {
        self.singleflight
            .lock()
            .entry(key.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

static FINALIZED_BLOCK_CACHES: OnceLock<Mutex<HashMap<String, Arc<EndpointRequestCache>>>> =
    OnceLock::new();

fn endpoint_request_cache(endpoint: String, ttl: Duration) -> Arc<EndpointRequestCache> {
    FINALIZED_BLOCK_CACHES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .entry(endpoint)
        .or_insert_with(|| Arc::new(EndpointRequestCache::new(ttl)))
        .clone()
}

fn request_cache_key<T: Serialize>(method: &str, params: &T) -> Option<(RequestCacheKey, Value)> {
    let params = serde_json::to_value(params).ok()?;
    let method = match method {
        BLOCK_NUMBER_RPC => DynamicBlockMethod::BlockNumber,
        GET_BLOCK_BY_NUMBER_RPC
            if params
                .as_array()
                .and_then(|values| values.first())
                .and_then(Value::as_str)
                .is_some_and(|tag| DYNAMIC_BLOCK_TAGS.contains(&tag)) =>
        {
            DynamicBlockMethod::GetBlockByNumber
        }
        _ => return None,
    };
    let serialized_params = match method {
        DynamicBlockMethod::BlockNumber => Vec::new(),
        DynamicBlockMethod::GetBlockByNumber => serde_json::to_vec(&params).ok()?,
    };
    Some((
        RequestCacheKey {
            method,
            params: serialized_params,
        },
        params,
    ))
}

fn deserialize_response<R: DeserializeOwned>(response: Value) -> Option<R> {
    serde_json::from_value(response).ok()
}

/// An ethers-rs JsonRpcClient wrapper that instruments requests with prometheus
/// metrics. To make this as flexible as possible, the metric vecs need to be
/// created and named externally, they should follow the naming convention here
/// and must include the described labels.
pub struct PrometheusJsonRpcClient<C> {
    inner: C,
    metrics: PrometheusClientMetrics,
    config: PrometheusConfig,
    finalized_block_cache: Option<Arc<EndpointRequestCache>>,
}

impl<C> PrometheusJsonRpcClient<C> {
    /// Create new PrometheusJsonRpcClient
    pub fn new(inner: C, metrics: PrometheusClientMetrics, config: PrometheusConfig) -> Self {
        // increment provider metric count
        let chain_name = PrometheusConfig::chain_name(&config.chain);
        metrics.increment_provider_instance(chain_name);

        Self {
            inner,
            metrics,
            config,
            finalized_block_cache: None,
        }
    }

    /// Coalesce dynamic block-tip reads made through the same concrete RPC endpoint.
    pub fn with_finalized_block_cache(mut self, endpoint: impl Into<String>) -> Self {
        self.finalized_block_cache = Some(endpoint_request_cache(
            endpoint.into(),
            FINALIZED_BLOCK_CACHE_TTL,
        ));
        self
    }

    #[cfg(test)]
    fn with_finalized_block_cache_ttl(
        mut self,
        endpoint: impl Into<String>,
        ttl: Duration,
    ) -> Self {
        self.finalized_block_cache = Some(endpoint_request_cache(endpoint.into(), ttl));
        self
    }
}

impl<C> Drop for PrometheusJsonRpcClient<C> {
    fn drop(&mut self) {
        // decrement provider metric count
        let chain_name = PrometheusConfig::chain_name(&self.config.chain);
        self.metrics.decrement_provider_instance(chain_name);
    }
}

impl<C: Clone> Clone for PrometheusJsonRpcClient<C> {
    fn clone(&self) -> Self {
        let mut cloned = Self::new(
            self.inner.clone(),
            self.metrics.clone(),
            self.config.clone(),
        );
        cloned.finalized_block_cache = self.finalized_block_cache.clone();
        cloned
    }
}

impl<C> Debug for PrometheusJsonRpcClient<C>
where
    C: JsonRpcClient,
{
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "PrometheusJsonRpcClient({:?})", self.inner)
    }
}

impl<C> PrometheusJsonRpcClient<C> {
    /// The inner RpcClient implementation
    pub fn inner(&self) -> &C {
        &self.inner
    }
}

impl<C> PrometheusConfigExt for PrometheusJsonRpcClient<C> {
    /// The "host" part of the URL this node is connecting to. E.g.
    /// `avalanche.api.onfinality.io`.
    fn node_host(&self) -> &str {
        self.config.node_host()
    }

    /// Chain name this RPC client is connected to.
    fn chain_name(&self) -> &str {
        self.config.chain_name()
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl<C> JsonRpcClient for PrometheusJsonRpcClient<C>
where
    C: JsonRpcClient,
{
    type Error = C::Error;

    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        if let Some(cache) = self
            .finalized_block_cache
            .as_ref()
            .and_then(|cache| request_cache_key(method, &params).map(|key| (cache, key)))
        {
            let (cache, (key, params)) = cache;
            self.metrics
                .increment_request_cache_metric(&self.config, method, "logical_read");

            if let Some(response) = cache.get(&key) {
                if let Some(response) = deserialize_response(response) {
                    self.metrics
                        .increment_request_cache_metric(&self.config, method, "cache_hit");
                    return Ok(response);
                }
                cache.remove(&key);
            }

            let singleflight = cache.singleflight(&key);
            let _guard = singleflight.lock().await;
            if let Some(response) = cache.get(&key) {
                if let Some(response) = deserialize_response(response) {
                    self.metrics
                        .increment_request_cache_metric(&self.config, method, "cache_hit");
                    return Ok(response);
                }
                cache.remove(&key);
            }

            self.metrics
                .increment_request_cache_metric(&self.config, method, "upstream_read");
            let response: Value = {
                let start = Instant::now();
                let result = self.inner.request(method, params.clone()).await;
                self.metrics
                    .increment_metrics(&self.config, method, start, result.is_ok());
                match result {
                    Ok(response) => response,
                    Err(error) => {
                        self.metrics.increment_request_cache_metric(
                            &self.config,
                            method,
                            "upstream_error",
                        );
                        return Err(error);
                    }
                }
            };

            if let Some(decoded) = deserialize_response(response.clone()) {
                cache.insert(key, response);
                return Ok(decoded);
            }

            // Preserve the inner client's typed deserialization error.
            self.metrics
                .increment_request_cache_metric(&self.config, method, "upstream_read");
            let start = Instant::now();
            let result = self.inner.request(method, params).await;
            self.metrics
                .increment_metrics(&self.config, method, start, result.is_ok());
            if result.is_err() {
                self.metrics
                    .increment_request_cache_metric(&self.config, method, "upstream_error");
            }
            return result;
        }

        let start = Instant::now();
        let res = self.inner.request(method, params).await;
        self.metrics
            .increment_metrics(&self.config, method, start, res.is_ok());
        res
    }
}

impl<C: JsonRpcClient + 'static> From<PrometheusJsonRpcClient<C>>
    for JsonRpcBlockGetter<PrometheusJsonRpcClient<C>>
{
    fn from(val: PrometheusJsonRpcClient<C>) -> Self {
        JsonRpcBlockGetter::new(val)
    }
}

/// Utility struct for implementing `BlockNumberGetter`
#[derive(Debug, new)]
pub struct JsonRpcBlockGetter<T: JsonRpcClient>(T);

/// RPC method for getting the latest block number
pub const BLOCK_NUMBER_RPC: &str = "eth_blockNumber";

#[async_trait]
impl<C> BlockNumberGetter for JsonRpcBlockGetter<C>
where
    C: JsonRpcClient,
{
    async fn get_block_number(&self) -> ChainResult<u64> {
        let res = self
            .0
            .request(BLOCK_NUMBER_RPC, ())
            .await
            .map(|r: U64| r.as_u64())
            .map_err(Into::into)?;
        Ok(res)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex as StdMutex,
        },
    };

    use ethers::providers::HttpClientError;
    use prometheus::{IntCounterVec, Opts};
    use serde_json::json;
    use tokio::sync::{Barrier, Notify};

    use super::*;

    #[derive(Clone, Debug, Default)]
    struct CountingClient {
        calls: Arc<AtomicUsize>,
        failures: usize,
        first_call_started: Option<Arc<Notify>>,
        block_first_call: Option<Arc<Notify>>,
        heights: Option<Arc<StdMutex<VecDeque<u64>>>>,
    }

    #[async_trait]
    impl JsonRpcClient for CountingClient {
        type Error = HttpClientError;

        async fn request<T, R>(&self, method: &str, _params: T) -> Result<R, Self::Error>
        where
            T: Debug + Serialize + Send + Sync,
            R: DeserializeOwned,
        {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call == 0 {
                if let Some(started) = &self.first_call_started {
                    started.notify_waiters();
                }
                if let Some(release) = &self.block_first_call {
                    release.notified().await;
                }
            }
            if call < self.failures {
                let text = "invalid json".to_owned();
                return Err(HttpClientError::SerdeJson {
                    err: serde_json::from_str::<Value>(&text)
                        .expect_err("mock response should be invalid"),
                    text,
                });
            }

            let height = self
                .heights
                .as_ref()
                .and_then(|heights| {
                    heights
                        .lock()
                        .expect("heights mutex should not be poisoned")
                        .pop_front()
                })
                .unwrap_or(100);
            let response = match method {
                BLOCK_NUMBER_RPC => json!(format!("0x{height:x}")),
                GET_BLOCK_BY_NUMBER_RPC => json!({"number": format!("0x{height:x}")}),
                _ => json!(null),
            };
            serde_json::from_value(response.clone()).map_err(|err| HttpClientError::SerdeJson {
                err,
                text: response.to_string(),
            })
        }
    }

    fn cache_metrics() -> PrometheusClientMetrics {
        let request_cache_count = IntCounterVec::new(
            Opts::new("test_request_cache_count", "test request cache count"),
            &["provider_node", "chain", "method", "result", "rpc_role"],
        )
        .expect("test metric should be valid");
        PrometheusClientMetrics {
            request_cache_count: Some(request_cache_count),
            ..PrometheusClientMetrics::default()
        }
    }

    fn cached_client(
        endpoint: &str,
        inner: CountingClient,
        metrics: PrometheusClientMetrics,
        ttl: Duration,
    ) -> PrometheusJsonRpcClient<CountingClient> {
        PrometheusJsonRpcClient::new(inner, metrics, PrometheusConfig::default())
            .with_finalized_block_cache_ttl(endpoint, ttl)
    }

    #[tokio::test]
    async fn concurrent_reads_share_one_upstream_request_per_endpoint() {
        let inner = CountingClient::default();
        let calls = inner.calls.clone();
        let metrics = cache_metrics();
        let client = cached_client(
            "concurrent-endpoint",
            inner,
            metrics.clone(),
            Duration::from_secs(1),
        );
        let barrier = Arc::new(Barrier::new(8));

        let tasks = (0..8)
            .map(|_| {
                let client = client.clone();
                let barrier = barrier.clone();
                tokio::spawn(async move {
                    barrier.wait().await;
                    client.request::<_, U64>(BLOCK_NUMBER_RPC, ()).await
                })
            })
            .collect::<Vec<_>>();

        for task in tasks {
            assert_eq!(
                task.await
                    .expect("task should not panic")
                    .expect("request should succeed"),
                U64::from(100_u64)
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let metric = metrics
            .request_cache_count
            .expect("cache metric should be configured");
        assert_eq!(
            metric
                .with_label_values(&[
                    "unknown",
                    "unknown",
                    BLOCK_NUMBER_RPC,
                    "logical_read",
                    "primary",
                ])
                .get(),
            8
        );
        assert_eq!(
            metric
                .with_label_values(&[
                    "unknown",
                    "unknown",
                    BLOCK_NUMBER_RPC,
                    "upstream_read",
                    "primary",
                ])
                .get(),
            1
        );
        assert_eq!(
            metric
                .with_label_values(&[
                    "unknown",
                    "unknown",
                    BLOCK_NUMBER_RPC,
                    "cache_hit",
                    "primary",
                ])
                .get(),
            7
        );
    }

    #[tokio::test]
    async fn different_endpoints_do_not_share_heights() {
        let inner = CountingClient::default();
        let calls = inner.calls.clone();
        let first = cached_client(
            "endpoint-one",
            inner.clone(),
            PrometheusClientMetrics::default(),
            Duration::from_secs(1),
        );
        let second = cached_client(
            "endpoint-two",
            inner,
            PrometheusClientMetrics::default(),
            Duration::from_secs(1),
        );

        first
            .request::<_, U64>(BLOCK_NUMBER_RPC, ())
            .await
            .expect("first request should succeed");
        second
            .request::<_, U64>(BLOCK_NUMBER_RPC, ())
            .await
            .expect("second request should succeed");

        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failures_are_not_cached() {
        let inner = CountingClient {
            failures: 1,
            ..CountingClient::default()
        };
        let calls = inner.calls.clone();
        let client = cached_client(
            "failure-endpoint",
            inner,
            PrometheusClientMetrics::default(),
            Duration::from_secs(1),
        );

        assert!(client
            .request::<_, U64>(BLOCK_NUMBER_RPC, ())
            .await
            .is_err());
        assert_eq!(
            client
                .request::<_, U64>(BLOCK_NUMBER_RPC, ())
                .await
                .expect("second request should retry"),
            U64::from(100_u64)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn successful_values_expire_at_the_cache_boundary() {
        let inner = CountingClient::default();
        let calls = inner.calls.clone();
        let client = cached_client(
            "expiry-endpoint",
            inner,
            PrometheusClientMetrics::default(),
            Duration::from_millis(20),
        );

        client
            .request::<_, U64>(BLOCK_NUMBER_RPC, ())
            .await
            .expect("first request should succeed");
        client
            .request::<_, U64>(BLOCK_NUMBER_RPC, ())
            .await
            .expect("cached request should succeed");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(30)).await;
        client
            .request::<_, U64>(BLOCK_NUMBER_RPC, ())
            .await
            .expect("expired request should refresh");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn lower_endpoint_heights_are_observable_after_expiry() {
        let inner = CountingClient {
            heights: Some(Arc::new(StdMutex::new(VecDeque::from([100, 99])))),
            ..CountingClient::default()
        };
        let client = cached_client(
            "lower-height-endpoint",
            inner,
            PrometheusClientMetrics::default(),
            Duration::from_millis(20),
        );

        assert_eq!(
            client
                .request::<_, U64>(BLOCK_NUMBER_RPC, ())
                .await
                .expect("first request should succeed"),
            U64::from(100_u64)
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            client
                .request::<_, U64>(BLOCK_NUMBER_RPC, ())
                .await
                .expect("expired request should refresh"),
            U64::from(99_u64)
        );
    }

    #[tokio::test]
    async fn cancelled_initializer_does_not_strand_followers() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let inner = CountingClient {
            first_call_started: Some(started.clone()),
            block_first_call: Some(release),
            ..CountingClient::default()
        };
        let calls = inner.calls.clone();
        let client = cached_client(
            "cancel-endpoint",
            inner,
            PrometheusClientMetrics::default(),
            Duration::from_secs(1),
        );
        let started_wait = started.notified();
        let leader = {
            let client = client.clone();
            tokio::spawn(async move { client.request::<_, U64>(BLOCK_NUMBER_RPC, ()).await })
        };
        started_wait.await;
        let follower = {
            let client = client.clone();
            tokio::spawn(async move { client.request::<_, U64>(BLOCK_NUMBER_RPC, ()).await })
        };
        tokio::task::yield_now().await;
        leader.abort();

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), follower)
                .await
                .expect("follower should not be stranded")
                .expect("follower should not panic")
                .expect("follower should retry"),
            U64::from(100_u64)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn only_dynamic_block_tags_are_cached() {
        let inner = CountingClient::default();
        let calls = inner.calls.clone();
        let client = cached_client(
            "tag-endpoint",
            inner,
            PrometheusClientMetrics::default(),
            Duration::from_secs(1),
        );

        for _ in 0..2 {
            client
                .request::<_, Value>(GET_BLOCK_BY_NUMBER_RPC, ("finalized", false))
                .await
                .expect("dynamic block request should succeed");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        for _ in 0..2 {
            client
                .request::<_, Value>(GET_BLOCK_BY_NUMBER_RPC, ("safe", false))
                .await
                .expect("safe block request should succeed");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        for _ in 0..2 {
            client
                .request::<_, Value>(GET_BLOCK_BY_NUMBER_RPC, ("0x10", false))
                .await
                .expect("pinned block request should succeed");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }
}
