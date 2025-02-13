use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, BLOCK_NUMBER_RPC};
use hyperlane_core::rpc_clients::test::ProviderMock;
use hyperlane_core::rpc_clients::FallbackProviderBuilder;

use super::*;

#[derive(Debug, Clone)]
struct EthereumProviderMock {
    provider: ProviderMock,
    success: bool,
}

impl Default for EthereumProviderMock {
    fn default() -> Self {
        Self {
            provider: ProviderMock::default(),
            success: true,
        }
    }
}

impl Deref for EthereumProviderMock {
    type Target = ProviderMock;

    fn deref(&self) -> &Self::Target {
        &self.provider
    }
}

impl EthereumProviderMock {
    fn new(request_sleep: Option<Duration>, success: bool) -> Self {
        Self {
            provider: ProviderMock::new(request_sleep),
            success,
        }
    }
}

impl From<EthereumProviderMock> for JsonRpcBlockGetter<EthereumProviderMock> {
    fn from(val: EthereumProviderMock) -> Self {
        JsonRpcBlockGetter::new(val)
    }
}

fn dummy_success_return_value<R: DeserializeOwned>() -> Result<R, HttpClientError> {
    serde_json::from_str("0").map_err(|e| HttpClientError::SerdeJson {
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
        if let Some(sleep_duration) = self.provider.request_sleep() {
            sleep(sleep_duration).await;
        }
        self.push(method, params);
        if self.success {
            dummy_success_return_value()
        } else {
            dummy_error_return_value()
        }
    }
}

impl PrometheusJsonRpcClientConfigExt for EthereumProviderMock {
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
        + PrometheusJsonRpcClientConfigExt
        + Into<JsonRpcBlockGetter<C>>
        + Clone,
    JsonRpcBlockGetter<C>: BlockNumberGetter,
{
    async fn fallback_test_call(&self) {
        self.request::<_, u64>(BLOCK_NUMBER_RPC, ()).await.unwrap();
    }
}

#[tokio::test]
async fn test_multicast_first_provider_succeeds() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::default(),
        EthereumProviderMock::default(),
        EthereumProviderMock::default(),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    ethereum_fallback_provider
        .multicast::<_, u64>(BLOCK_NUMBER_RPC, ())
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_call_count, vec![1, 0, 0]);
}

#[tokio::test]
async fn test_multicast_second_provider_succeeds() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None, false),
        EthereumProviderMock::default(),
        EthereumProviderMock::default(),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    ethereum_fallback_provider
        .multicast::<_, u64>(BLOCK_NUMBER_RPC, ())
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_call_count, vec![1, 1, 0]);
}

#[tokio::test]
async fn test_multicast_first_provider_slow() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10)), true),
        EthereumProviderMock::new(None, false),
        EthereumProviderMock::default(),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    ethereum_fallback_provider
        .multicast::<_, u64>(BLOCK_NUMBER_RPC, ())
        .await
        .unwrap();
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_call_count, vec![0, 1, 1]);
}

#[tokio::test]
async fn test_multicast_none_provider_succeeds() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(None, false),
        EthereumProviderMock::new(None, false),
        EthereumProviderMock::new(None, false),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    let _ = ethereum_fallback_provider
        .multicast::<_, u64>(BLOCK_NUMBER_RPC, ())
        .await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_call_count, vec![4, 4, 4]);
}

#[tokio::test]
async fn test_fallback_first_provider_is_attempted() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::default(),
        EthereumProviderMock::default(),
        EthereumProviderMock::default(),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    ethereum_fallback_provider.fallback_test_call().await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_call_count, vec![1, 0, 0]);
}

#[tokio::test]
async fn test_fallback_one_stalled_provider() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10)), true),
        EthereumProviderMock::default(),
        EthereumProviderMock::default(),
    ];
    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(0))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    ethereum_fallback_provider.fallback_test_call().await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_call_count, vec![0, 0, 2]);
}

// TODO: make `categorize_client_response` generic over `ProviderError` to allow testing
// two stalled providers (so that the for loop in `request` doesn't stop after the first provider)
