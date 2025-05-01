use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, BLOCK_NUMBER_RPC};
use hyperlane_core::rpc_clients::test::ProviderMock;
use hyperlane_core::rpc_clients::FallbackProviderBuilder;

use super::*;

#[derive(Debug, Clone)]
struct EthereumProviderMock {
    provider: ProviderMock,
    block_number: Option<u64>,
}

impl Deref for EthereumProviderMock {
    type Target = ProviderMock;

    fn deref(&self) -> &Self::Target {
        &self.provider
    }
}

impl EthereumProviderMock {
    fn new(request_sleep: Option<Duration>, block_number: Option<u64>) -> Self {
        Self {
            provider: ProviderMock::new(request_sleep),
            block_number,
        }
    }
}

impl From<EthereumProviderMock> for JsonRpcBlockGetter<EthereumProviderMock> {
    fn from(val: EthereumProviderMock) -> Self {
        JsonRpcBlockGetter::new(val)
    }
}

fn dummy_success_return_value<R: DeserializeOwned>(
    block_number: u64,
) -> Result<R, HttpClientError> {
    serde_json::from_str(&block_number.to_string()).map_err(|e| HttpClientError::SerdeJson {
        err: e,
        text: "".to_owned(),
    })
}

fn dummy_error_return_value<R: DeserializeOwned>() -> Result<R, HttpClientError> {
    serde_json::from_str("not-a-json").map_err(|e| HttpClientError::SerdeJson {
        err: e,
        text: "".to_owned(),
    })
}

#[async_trait]
impl JsonRpcClient for EthereumProviderMock {
    type Error = HttpClientError;

    /// Pushes the `(method, params)` to the back of the `requests` queue,
    /// pops the responses from the back of the `responses` queue
    async fn request<T: Debug + Serialize + Send + Sync, R: DeserializeOwned>(
        &self,
        method: &str,
        params: T,
    ) -> Result<R, Self::Error> {
        self.push(method, params);
        if let Some(sleep_duration) = self.provider.request_sleep() {
            sleep(sleep_duration).await;
        }
        if self.block_number.is_none() {
            dummy_error_return_value()
        } else {
            dummy_success_return_value(self.block_number.unwrap())
        }
    }
}

impl PrometheusConfigExt for EthereumProviderMock {
    fn node_host(&self) -> &str {
        todo!()
    }

    fn chain_name(&self) -> &str {
        todo!()
    }
}

impl<C> EthereumFallbackProvider<C, JsonRpcBlockGetter<C>>
where
    C: JsonRpcClient<Error = HttpClientError>
        + PrometheusConfigExt
        + Into<JsonRpcBlockGetter<C>>
        + Clone,
    JsonRpcBlockGetter<C>: BlockNumberGetter,
{
    async fn fallback_test_call(&self) -> u64 {
        self.request::<_, u64>(BLOCK_NUMBER_RPC, ()).await.unwrap()
    }

    async fn multicast_test_call(&self) -> Result<u64, ProviderError> {
        self.request::<_, u64>(METHOD_SEND_RAW_TRANSACTION, ())
            .await
    }
}

// Explanation of the test expected result:
// FutureUnordered builds internal queue and all futures are inserted into the queue in the order
//  they are added. On the first pass, FutureUnordered iterates through the queue in the order in
//  which the futures were pushed into it. Since the first future resolves into Poll::Ready, only
//  this future is polled.
// FutureUnordered does not guarantee that it will return the results from each future in the same
//  order as they were pushed into it. FutureUnordered will return the result of the first future
//  which becomes ready. It just happened in this test case that the first future is polled first
//  and provide results first.
#[tokio::test]
async fn test_multicast_first_provider_succeeds_immediately() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None, Some(1)),
        EthereumProviderMock::new(None, Some(2)),
        EthereumProviderMock::new(None, Some(3)),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 1);
    assert_eq!(provider_call_count, vec![1, 0, 0]);
}

#[tokio::test]
async fn test_multicast_second_provider_succeeds_immediately() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None, None),
        EthereumProviderMock::new(None, Some(2)),
        EthereumProviderMock::new(None, Some(3)),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 2);
    assert_eq!(provider_call_count, vec![1, 1, 0]);
}

#[tokio::test]
async fn test_multicast_third_provider_succeeds_immediately() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None, None),
        EthereumProviderMock::new(None, None),
        EthereumProviderMock::new(None, Some(3)),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 3);
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tokio::test]
async fn test_multicast_first_provider_succeeds_slow() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10)), Some(1)),
        EthereumProviderMock::new(None, None),
        EthereumProviderMock::new(None, None),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 1);
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tokio::test]
async fn test_multicast_second_provider_succeeds_slow() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None, None),
        EthereumProviderMock::new(Some(Duration::from_millis(10)), Some(2)),
        EthereumProviderMock::new(None, None),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 2);
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tokio::test]
async fn test_multicast_first_provider_succeeds_slow_third_succeeds_immediately() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10)), Some(1)),
        EthereumProviderMock::new(None, None),
        EthereumProviderMock::new(None, Some(3)),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 3);
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tokio::test]
async fn test_multicast_first_provider_succeeds_slow_second_succeeds_quicker() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10)), Some(1)),
        EthereumProviderMock::new(Some(Duration::from_millis(5)), Some(2)),
        EthereumProviderMock::new(None, None),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let provider_id = ethereum_fallback_provider
        .multicast_test_call()
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 2);
    assert_eq!(provider_call_count, vec![1, 1, 1]);
}

#[tokio::test]
async fn test_multicast_none_provider_succeeds() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None, None),
        EthereumProviderMock::new(None, None),
        EthereumProviderMock::new(None, None),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let result = ethereum_fallback_provider.multicast_test_call().await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    matches!(result, Err(ProviderError::JsonRpcClientError(_)));
    assert_eq!(provider_call_count, vec![4, 4, 4]);
}

#[tokio::test]
async fn test_fallback_first_provider_is_attempted() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None, Some(1)),
        EthereumProviderMock::new(None, Some(2)),
        EthereumProviderMock::new(None, Some(3)),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let provider_id = ethereum_fallback_provider.fallback_test_call().await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 1);
    assert_eq!(provider_call_count, vec![1, 0, 0]);
}

#[tokio::test]
async fn test_fallback_one_stalled_provider() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10)), Some(1)),
        EthereumProviderMock::new(None, Some(2)),
        EthereumProviderMock::new(None, Some(3)),
    ];
    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(0))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let provider_id = ethereum_fallback_provider.fallback_test_call().await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_id, 1);
    // The stalled provider is moved from 0th place to 2nd place in `provider_call_count
    // The value 2 is explained by how `handle_stalled_provider` is implemented:
    // we used the same kind of request there as in implementation of mock providers.
    assert_eq!(provider_call_count, vec![0, 0, 2]);
}

// TODO: make `categorize_client_response` generic over `ProviderError` to allow testing
// two stalled providers (so that the for loop in `request` doesn't stop after the first provider)
