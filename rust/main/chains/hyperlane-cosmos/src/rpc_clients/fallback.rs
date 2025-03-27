use std::{
    fmt::{Debug, Formatter},
    ops::Deref,
};

use derive_new::new;
use hyperlane_core::rpc_clients::FallbackProvider;

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
        self.fallback_provider.fmt(f)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use async_trait::async_trait;
    use hyperlane_core::rpc_clients::test::ProviderMock;
    use hyperlane_core::rpc_clients::{BlockNumberGetter, FallbackProviderBuilder};
    use hyperlane_core::ChainResult;
    use tokio::time::sleep;

    use super::*;

    #[derive(Debug, Clone, Default)]
    struct CosmosProviderMock(ProviderMock);

    impl Deref for CosmosProviderMock {
        type Target = ProviderMock;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl CosmosProviderMock {
        fn new(request_sleep: Option<Duration>) -> Self {
            Self(ProviderMock::new(request_sleep))
        }
    }

    #[async_trait]
    impl BlockNumberGetter for CosmosProviderMock {
        async fn get_block_number(&self) -> ChainResult<u64> {
            Ok(0)
        }
    }

    impl From<CosmosProviderMock> for Box<dyn BlockNumberGetter> {
        fn from(val: CosmosProviderMock) -> Self {
            Box::new(val)
        }
    }

    impl CosmosFallbackProvider<CosmosProviderMock> {
        async fn low_level_test_call(&mut self) -> ChainResult {
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
                Box::pin(future)
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
