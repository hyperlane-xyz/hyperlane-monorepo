use ethers_prometheus::json_rpc_client::{JsonRpcBlockGetter, BLOCK_NUMBER_RPC};
use hyperlane_core::rpc_clients::test::ProviderMock;
use hyperlane_core::rpc_clients::FallbackProviderBuilder;

use super::*;

#[derive(Debug, Clone, Default)]
struct EthereumProviderMock(ProviderMock);

impl Deref for EthereumProviderMock {
    type Target = ProviderMock;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl EthereumProviderMock {
    fn new(request_sleep: Option<Duration>) -> Self {
        Self(ProviderMock::new(request_sleep))
    }
}

impl From<EthereumProviderMock> for JsonRpcBlockGetter<EthereumProviderMock> {
    fn from(val: EthereumProviderMock) -> Self {
        JsonRpcBlockGetter::new(val)
    }
}

fn dummy_return_value<R: DeserializeOwned>() -> Result<R, HttpClientError> {
    serde_json::from_str("0").map_err(|e| HttpClientError::SerdeJson {
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
        if let Some(sleep_duration) = self.request_sleep() {
            sleep(sleep_duration).await;
        }
        dummy_return_value()
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
    async fn low_level_test_call(&self) {
        self.request::<_, u64>(BLOCK_NUMBER_RPC, ()).await.unwrap();
    }
}

#[tokio::test]
async fn test_first_provider_is_attempted() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::default(),
        EthereumProviderMock::default(),
        EthereumProviderMock::default(),
    ];
    let fallback_provider = fallback_provider_builder.add_providers(providers).build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    ethereum_fallback_provider.low_level_test_call().await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_call_count, vec![1, 0, 0]);
}

#[tokio::test]
async fn test_one_stalled_provider() {
    let fallback_provider_builder = FallbackProviderBuilder::default();
    let providers = vec![
        EthereumProviderMock::new(Some(Duration::from_millis(10))),
        EthereumProviderMock::default(),
        EthereumProviderMock::default(),
    ];
    let fallback_provider = fallback_provider_builder
        .add_providers(providers)
        .with_max_block_time(Duration::from_secs(0))
        .build();
    let ethereum_fallback_provider = EthereumFallbackProvider::new(fallback_provider);
    ethereum_fallback_provider.low_level_test_call().await;
    let provider_call_count: Vec<_> =
        ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
    assert_eq!(provider_call_count, vec![0, 0, 2]);
}

// TODO: make `categorize_client_response` generic over `ProviderError` to allow testing
// two stalled providers (so that the for loop in `request` doesn't stop after the first provider)
