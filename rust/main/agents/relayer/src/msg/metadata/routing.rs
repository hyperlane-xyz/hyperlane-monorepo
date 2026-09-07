use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use hyperlane_base::cache::FunctionCallCache;

use hyperlane_core::{HyperlaneMessage, Metadata, ModuleType, RoutingIsm, H256};
use tracing::instrument;

use super::{
    base::MessageMetadataBuildParams, IsmCachePolicy, MessageMetadataBuilder, MetadataBuildError,
    MetadataBuilder,
};

#[derive(Clone, Debug, new, Deref)]
pub struct RoutingIsmMetadataBuilder {
    base: MessageMetadataBuilder,
}

#[async_trait]
impl MetadataBuilder for RoutingIsmMetadataBuilder {
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    #[instrument(skip(self, message, params))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        let ism = self
            .base_builder()
            .build_routing_ism(ism_address)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

        let cache_policy = self
            .base_builder()
            .ism_cache_policy_classifier()
            .get_cache_policy(
                self.root_ism,
                ism.domain(),
                ModuleType::Routing,
                self.base.app_context.as_ref(),
            )
            .await;

        let module = self.route(ism.as_ref(), message, cache_policy).await?;

        self.base.build(module, message, params).await
    }
}

impl RoutingIsmMetadataBuilder {
    async fn route(
        &self,
        ism: &dyn RoutingIsm,
        message: &HyperlaneMessage,
        cache_policy: IsmCachePolicy,
    ) -> Result<H256, MetadataBuildError> {
        let ism_domain = ism.domain().name();
        let fn_key = "route";

        let cache_result: Option<H256> = match cache_policy {
            // if cache is ISM specific, we use the message origin for caching
            IsmCachePolicy::IsmSpecific => {
                let params_cache_key = (ism.address(), message.origin);
                self.base_builder()
                    .cache()
                    .get_cached_call_result(ism_domain, fn_key, &params_cache_key)
                    .await
            }
            // if cache is Message specific, we use the message id for caching
            IsmCachePolicy::MessageSpecific => {
                let params_cache_key = (ism.address(), message.id());
                self.base_builder()
                    .cache()
                    .get_cached_call_result(ism_domain, fn_key, &params_cache_key)
                    .await
            }
        }
        .map_err(|err| {
            tracing::warn!(error = %err, "Error when caching call result for {:?}", fn_key);
        })
        .ok()
        .flatten();

        let module = match cache_result {
            Some(result) => result,
            None => {
                let module = ism
                    .route(message)
                    .await
                    .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

                // store result in cache
                match cache_policy {
                    IsmCachePolicy::IsmSpecific => {
                        let params_cache_key = (ism.address(), message.origin);
                        self.base_builder()
                            .cache()
                            .cache_call_result(ism_domain, fn_key, &params_cache_key, &module)
                            .await
                    }
                    IsmCachePolicy::MessageSpecific => {
                        let params_cache_key = (ism.address(), message.id());
                        self.base_builder()
                            .cache()
                            .cache_call_result(ism_domain, fn_key, &params_cache_key, &module)
                            .await
                    }
                }
                .map_err(|err| {
                    tracing::warn!(error = %err, "Error when caching call result for {:?}", fn_key);
                })
                .ok();
                module
            }
        };

        Ok(module)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use hyperlane_base::cache::{
        LocalCache, MeteredCache, MeteredCacheConfig, MeteredCacheMetricsBuilder, OptionalCache,
    };
    use hyperlane_core::{
        ChainCommunicationError, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
        HyperlaneMessage, KnownHyperlaneDomain, RoutingIsm, H256,
    };

    use crate::{
        msg::metadata::message_builder::MessageMetadataBuilder,
        test_utils::mock_base_builder::build_mock_base_builder,
    };

    use super::{IsmCachePolicy, RoutingIsmMetadataBuilder};

    #[derive(Debug)]
    struct CountingRoutingIsm {
        address: H256,
        domain: HyperlaneDomain,
        calls: Arc<AtomicUsize>,
        fail_first: bool,
    }

    #[async_trait::async_trait]
    impl RoutingIsm for CountingRoutingIsm {
        async fn route(&self, _message: &HyperlaneMessage) -> ChainResult<H256> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_first && call == 0 {
                Err(ChainCommunicationError::from_other_str(
                    "simulated provider failure",
                ))
            } else {
                Ok(H256::from_low_u64_be(42))
            }
        }
    }

    impl HyperlaneContract for CountingRoutingIsm {
        fn address(&self) -> H256 {
            self.address
        }
    }

    impl HyperlaneChain for CountingRoutingIsm {
        fn domain(&self) -> &HyperlaneDomain {
            &self.domain
        }

        fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
            unimplemented!("provider is not used by routing cache tests")
        }
    }

    fn builder() -> RoutingIsmMetadataBuilder {
        let origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let destination = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
        let mut base = build_mock_base_builder(origin, destination);
        let cache_name = "routing-cache-test";
        base.responses.cache = Some(OptionalCache::new(Some(MeteredCache::new(
            LocalCache::new(cache_name),
            MeteredCacheMetricsBuilder::default()
                .build()
                .expect("cache metrics should build"),
            MeteredCacheConfig {
                cache_name: cache_name.to_owned(),
            },
        ))));

        RoutingIsmMetadataBuilder::new(MessageMetadataBuilder {
            base: Arc::new(base),
            app_context: None,
            root_ism: H256::from_low_u64_be(1),
            max_ism_depth: 10,
            max_ism_count: 10,
        })
    }

    fn ism(calls: Arc<AtomicUsize>, fail_first: bool) -> CountingRoutingIsm {
        ism_on_domain(calls, fail_first, KnownHyperlaneDomain::Arbitrum.into())
    }

    fn ism_on_domain(
        calls: Arc<AtomicUsize>,
        fail_first: bool,
        domain: HyperlaneDomain,
    ) -> CountingRoutingIsm {
        CountingRoutingIsm {
            address: H256::from_low_u64_be(1),
            domain,
            calls,
            fail_first,
        }
    }

    #[tokio::test]
    async fn ism_specific_routes_are_cached_by_origin_on_the_ism_domain() {
        let builder = builder();
        let calls = Arc::new(AtomicUsize::new(0));
        let ism = ism(calls.clone(), false);
        let ethereum_message = HyperlaneMessage {
            origin: HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum).id(),
            ..HyperlaneMessage::default()
        };
        let arbitrum_message = HyperlaneMessage {
            origin: HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum).id(),
            ..HyperlaneMessage::default()
        };

        assert_eq!(
            builder
                .route(&ism, &ethereum_message, IsmCachePolicy::IsmSpecific)
                .await
                .unwrap(),
            H256::from_low_u64_be(42)
        );
        assert_eq!(
            builder
                .route(&ism, &ethereum_message, IsmCachePolicy::IsmSpecific)
                .await
                .unwrap(),
            H256::from_low_u64_be(42)
        );
        builder
            .route(&ism, &arbitrum_message, IsmCachePolicy::IsmSpecific)
            .await
            .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn ism_specific_routes_are_isolated_by_ism_domain() {
        let builder = builder();
        let calls = Arc::new(AtomicUsize::new(0));
        let ethereum_ism =
            ism_on_domain(calls.clone(), false, KnownHyperlaneDomain::Ethereum.into());
        let arbitrum_ism =
            ism_on_domain(calls.clone(), false, KnownHyperlaneDomain::Arbitrum.into());
        let message = HyperlaneMessage::default();

        builder
            .route(&ethereum_ism, &message, IsmCachePolicy::IsmSpecific)
            .await
            .unwrap();
        builder
            .route(&arbitrum_ism, &message, IsmCachePolicy::IsmSpecific)
            .await
            .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn message_specific_routes_are_isolated_by_message_id() {
        let builder = builder();
        let calls = Arc::new(AtomicUsize::new(0));
        let ism = ism(calls.clone(), false);
        let first = HyperlaneMessage {
            nonce: 1,
            ..HyperlaneMessage::default()
        };
        let second = HyperlaneMessage {
            nonce: 2,
            ..HyperlaneMessage::default()
        };

        builder
            .route(&ism, &first, IsmCachePolicy::MessageSpecific)
            .await
            .unwrap();
        builder
            .route(&ism, &first, IsmCachePolicy::MessageSpecific)
            .await
            .unwrap();
        builder
            .route(&ism, &second, IsmCachePolicy::MessageSpecific)
            .await
            .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn failed_routes_are_not_cached() {
        let builder = builder();
        let calls = Arc::new(AtomicUsize::new(0));
        let ism = ism(calls.clone(), true);
        let message = HyperlaneMessage::default();

        assert!(builder
            .route(&ism, &message, IsmCachePolicy::MessageSpecific)
            .await
            .is_err());
        assert!(builder
            .route(&ism, &message, IsmCachePolicy::MessageSpecific)
            .await
            .is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
