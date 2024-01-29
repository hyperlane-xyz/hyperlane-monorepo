use std::{
    fmt::Debug,
    future::Future,
    ops::Deref,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use async_trait::async_trait;
use derive_new::new;
use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProvider};
use tokio::time::sleep;
use tonic::client::GrpcService;
use tracing::warn_span;

use crate::HyperlaneCosmosError;

/// Wrapper of `FallbackProvider` for use in `hyperlane-cosmos`
#[derive(new, Clone)]
pub struct CosmosFallbackProvider<T>(FallbackProvider<T>);

impl<T> Deref for CosmosFallbackProvider<T> {
    type Target = FallbackProvider<T>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[async_trait]
impl<T, ReqBody> GrpcService<ReqBody> for CosmosFallbackProvider<T>
where
    T: GrpcService<ReqBody> + Clone + Debug + Into<Box<dyn BlockNumberGetter>> + 'static,
    <T as GrpcService<ReqBody>>::Error: Into<HyperlaneCosmosError>,
    ReqBody: Clone + 'static,
{
    type ResponseBody = T::ResponseBody;
    type Error = HyperlaneCosmosError;
    type Future =
        Pin<Box<dyn Future<Output = Result<http::Response<Self::ResponseBody>, Self::Error>>>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let mut provider = (*self.inner.providers)[0].clone();
        provider
            .poll_ready(cx)
            .map_err(Into::<HyperlaneCosmosError>::into)
    }

    fn call(&mut self, request: http::Request<ReqBody>) -> Self::Future {
        // use CategorizedResponse::*;
        let request = clone_request(&request);
        let cloned_self = self.clone();
        let f = async move {
            let mut errors = vec![];
            // make sure we do at least 4 total retries.
            while errors.len() <= 3 {
                if !errors.is_empty() {
                    sleep(Duration::from_millis(100)).await
                }
                let priorities_snapshot = cloned_self.take_priorities_snapshot().await;
                for (idx, priority) in priorities_snapshot.iter().enumerate() {
                    let mut provider = cloned_self.inner.providers[priority.index].clone();
                    let resp = provider.call(clone_request(&request)).await;
                    cloned_self
                        .handle_stalled_provider(priority, &provider)
                        .await;
                    let _span =
                        warn_span!("request", fallback_count=%idx, provider_index=%priority.index, ?provider).entered();

                    match resp {
                        Ok(r) => return Ok(r),
                        Err(e) => errors.push(e.into()),
                    }
                }
            }

            Err(HyperlaneCosmosError::FallbackProvidersFailed(errors))
        };
        Box::pin(f)
    }
}

fn clone_request<ReqBody>(request: &http::Request<ReqBody>) -> http::Request<ReqBody>
where
    ReqBody: Clone + 'static,
{
    let builder = http::Request::builder()
        .uri(request.uri().clone())
        .method(request.method().clone())
        .version(request.version());
    let builder = request.headers().iter().fold(builder, |builder, (k, v)| {
        builder.header(k.clone(), v.clone())
    });
    builder.body(request.body().clone()).unwrap()
}

#[cfg(test)]
mod tests {
    use hyperlane_core::rpc_clients::test::ProviderMock;
    use hyperlane_core::rpc_clients::FallbackProviderBuilder;

    use super::*;

    #[derive(Debug, Clone)]
    struct CosmosProviderMock(ProviderMock);
    impl Deref for CosmosProviderMock {
        type Target = ProviderMock;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }
    impl Default for CosmosProviderMock {
        fn default() -> Self {
            Self(ProviderMock::default())
        }
    }
    impl CosmosProviderMock {
        fn new(request_sleep: Option<Duration>) -> Self {
            Self(ProviderMock::new(request_sleep))
        }
    }

    impl Into<Box<dyn BlockNumberGetter>> for CosmosProviderMock {
        fn into(self) -> Box<dyn BlockNumberGetter> {
            Box::new(JsonRpcBlockGetter::new(self.clone()))
        }
    }

    // fn dummy_return_value<R: DeserializeOwned>() -> Result<R, HttpClientError> {
    //     serde_json::from_str("0").map_err(|e| HttpClientError::SerdeJson {
    //         err: e,
    //         text: "".to_owned(),
    //     })
    // }

    // #[async_trait]
    // impl JsonRpcClient for CosmosProviderMock {
    //     type Error = HttpClientError;

    //     /// Pushes the `(method, params)` to the back of the `requests` queue,
    //     /// pops the responses from the back of the `responses` queue
    //     async fn request<T: Debug + Serialize + Send + Sync, R: DeserializeOwned>(
    //         &self,
    //         method: &str,
    //         params: T,
    //     ) -> Result<R, Self::Error> {
    //         self.push(method, params);
    //         if let Some(sleep_duration) = self.request_sleep() {
    //             sleep(sleep_duration).await;
    //         }
    //         dummy_return_value()
    //     }
    // }

    impl PrometheusJsonRpcClientConfigExt for CosmosProviderMock {
        fn node_host(&self) -> &str {
            todo!()
        }

        fn chain_name(&self) -> &str {
            todo!()
        }
    }

    #[tokio::test]
    async fn test_first_provider_is_attempted() {
        let fallback_provider_builder = FallbackProviderBuilder::default();
        let providers = vec![
            CosmosProviderMock::default(),
            CosmosProviderMock::default(),
            CosmosProviderMock::default(),
        ];
        let fallback_provider = fallback_provider_builder.add_providers(providers).build();
        let ethereum_fallback_provider = CosmosFallbackProvider::new(fallback_provider);
        ethereum_fallback_provider
            .request::<_, u64>(BLOCK_NUMBER_RPC, ())
            .await
            .unwrap();
        let provider_call_count: Vec<_> =
            ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
        assert_eq!(provider_call_count, vec![1, 0, 0]);
    }

    #[tokio::test]
    async fn test_one_stalled_provider() {
        let fallback_provider_builder = FallbackProviderBuilder::default();
        let providers = vec![
            CosmosProviderMock::new(Some(Duration::from_millis(10))),
            CosmosProviderMock::default(),
            CosmosProviderMock::default(),
        ];
        let fallback_provider = fallback_provider_builder
            .add_providers(providers)
            .with_max_block_time(Duration::from_secs(0))
            .build();
        let ethereum_fallback_provider = CosmosFallbackProvider::new(fallback_provider);
        ethereum_fallback_provider
            .request::<_, u64>(BLOCK_NUMBER_RPC, ())
            .await
            .unwrap();

        let provider_call_count: Vec<_> =
            ProviderMock::get_call_counts(&ethereum_fallback_provider).await;
        // TODO: figure out why there are 2 BLOCK_NUMBER_RPC calls to the stalled provider instead of just one. This could be because
        // of how ethers work under the hood.
        assert_eq!(provider_call_count, vec![0, 0, 2]);
    }

    // TODO: make `categorize_client_response` generic over `ProviderError` to allow testing
    // two stalled providers (so that the for loop in `request` doesn't stop after the first provider)
}
