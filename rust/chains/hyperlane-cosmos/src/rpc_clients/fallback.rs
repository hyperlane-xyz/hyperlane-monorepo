use std::{
    fmt::Debug,
    future::Future,
    ops::Deref,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

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
    use async_trait::async_trait;
    use hyperlane_core::rpc_clients::test::ProviderMock;
    use hyperlane_core::rpc_clients::FallbackProviderBuilder;
    use hyperlane_core::ChainCommunicationError;

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

    #[async_trait]
    impl BlockNumberGetter for CosmosProviderMock {
        async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
            Ok(0)
        }
    }

    impl Into<Box<dyn BlockNumberGetter>> for CosmosProviderMock {
        fn into(self) -> Box<dyn BlockNumberGetter> {
            Box::new(self)
        }
    }

    impl<ReqBody> GrpcService<ReqBody> for CosmosProviderMock
    where
        ReqBody: Clone + 'static,
    {
        type ResponseBody = tonic::body::BoxBody;
        type Error = HyperlaneCosmosError;
        type Future =
            Pin<Box<dyn Future<Output = Result<http::Response<Self::ResponseBody>, Self::Error>>>>;

        fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            todo!()
        }

        fn call(&mut self, request: http::Request<ReqBody>) -> Self::Future {
            self.push(
                Default::default(),
                format!("method: {:?}, uri: {:?}", request.method(), request.uri()),
            );
            let body = tonic::body::BoxBody::default();
            let self_clone = self.clone();
            let f = async move {
                let response = http::Response::builder().status(200).body(body).unwrap();
                if let Some(sleep_duration) = self_clone.request_sleep() {
                    sleep(sleep_duration).await;
                }
                Ok(response)
            };
            Box::pin(f)
        }
    }

    impl CosmosFallbackProvider<CosmosProviderMock> {
        async fn low_level_test_call(&mut self) -> Result<(), ChainCommunicationError> {
            let request = http::Request::builder()
                .uri("http://localhost:1234")
                .method("GET")
                .body(())
                .unwrap();
            self.call(request).await?;
            Ok(())
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
        let mut cosmos_fallback_provider = CosmosFallbackProvider::new(fallback_provider);
        cosmos_fallback_provider
            .low_level_test_call()
            .await
            .unwrap();
        let provider_call_count: Vec<_> =
            ProviderMock::get_call_counts(&cosmos_fallback_provider).await;
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
        let mut cosmos_fallback_provider = CosmosFallbackProvider::new(fallback_provider);
        cosmos_fallback_provider
            .low_level_test_call()
            .await
            .unwrap();

        let provider_call_count: Vec<_> =
            ProviderMock::get_call_counts(&cosmos_fallback_provider).await;
        assert_eq!(provider_call_count, vec![0, 0, 1]);
    }
}
