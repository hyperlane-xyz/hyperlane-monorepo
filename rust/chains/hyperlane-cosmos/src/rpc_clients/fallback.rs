use std::{
    fmt::{Debug, Formatter},
    ops::Deref,
};

use derive_new::new;
use hyperlane_core::rpc_clients::FallbackProvider;
use itertools::Itertools;

/// Wrapper of `FallbackProvider` for use in `hyperlane-cosmos`
#[derive(new, Clone)]
pub struct CosmosFallbackProvider<T> {
    fallback_provider: FallbackProvider<T, T>,
}

impl<T> Deref for CosmosFallbackProvider<T> {
    type Target = FallbackProvider<T, T>;

    fn deref(&self) -> &Self::Target {
        &self.fallback_provider
    }
}

impl<C> Debug for CosmosFallbackProvider<C>
where
    C: Debug,
{
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        // iterate the inner providers and write them to the formatter
        f.debug_struct("FallbackProvider")
            .field(
                "providers",
                &self
                    .fallback_provider
                    .inner
                    .providers
                    .iter()
                    .map(|v| format!("{:?}", v))
                    .join(", "),
            )
            .finish()
    }
}

// impl<T> GrpcService<BoxBody> for CosmosFallbackProvider<T>
// where
//     T: GrpcService<BoxBody> + Clone + Debug + Into<Box<dyn BlockNumberGetter>> + 'static,
//     <T as GrpcService<BoxBody>>::Error: Into<StdError>,
//     <T as GrpcService<BoxBody>>::ResponseBody:
//         tonic::codegen::Body<Data = tonic::codegen::Bytes> + Send + 'static,
//     <T::ResponseBody as tonic::codegen::Body>::Error: Into<StdError> + Send,
// {
//     type ResponseBody = T::ResponseBody;
//     type Error = T::Error;
//     type Future =
//         Pin<Box<dyn Future<Output = Result<http::Response<Self::ResponseBody>, Self::Error>>>>;

//     fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
//         let mut provider = (*self.inner.providers)[0].clone();
//         provider.poll_ready(cx)
//     }

//     fn call(&mut self, request: http::Request<BoxBody>) -> Self::Future {
//         // use CategorizedResponse::*;
//         let request = clone_request(&request);
//         let cloned_self = self.clone();
//         let f = async move {
//             let mut errors = vec![];
//             // make sure we do at least 4 total retries.
//             while errors.len() <= 3 {
//                 if !errors.is_empty() {
//                     sleep(Duration::from_millis(100)).await
//                 }
//                 let priorities_snapshot = cloned_self.take_priorities_snapshot().await;
//                 for (idx, priority) in priorities_snapshot.iter().enumerate() {
//                     let mut provider = cloned_self.inner.providers[priority.index].clone();
//                     let resp = provider.call(clone_request(&request)).await;
//                     cloned_self
//                         .handle_stalled_provider(priority, &provider)
//                         .await;
//                     let _span =
//                         warn_span!("request", fallback_count=%idx, provider_index=%priority.index, ?provider).entered();

//                     match resp {
//                         Ok(r) => return Ok(r),
//                         Err(e) => errors.push(e.into()),
//                     }
//                 }
//             }

//             Err(HyperlaneCosmosError::FallbackProvidersFailed(errors))
//         };
//         Box::pin(f)
//     }
// }

// fn clone_request(request: &http::Request<BoxBody>) -> http::Request<BoxBody> {
//     let builder = http::Request::builder()
//         .uri(request.uri().clone())
//         .method(request.method().clone())
//         .version(request.version());
//     let builder = request.headers().iter().fold(builder, |builder, (k, v)| {
//         builder.header(k.clone(), v.clone())
//     });
//     builder.body(request.body().clone()).unwrap()
// }

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

    impl CosmosFallbackProvider<CosmosProviderMock> {
        async fn low_level_test_call(&mut self) -> Result<(), ChainCommunicationError> {
            self.call(|provider| {
                provider.push("GET", "http://localhost:1234");
                let future = async move {
                    let body = tonic::body::BoxBody::default();
                    let response = http::Response::builder().status(200).body(body).unwrap();
                    if let Some(sleep_duration) = provider.request_sleep() {
                        sleep(sleep_duration).await;
                    }
                    Ok(response)
                };
                Pin::from(Box::from(future))
            })
            .await?;
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
