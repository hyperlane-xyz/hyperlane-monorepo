#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue

use std::{fmt::Debug, sync::Arc};

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::{HyperlaneMessage, InterchainSecurityModule, ModuleType, H256};
use {
    hyperlane_base::cache::{FunctionCallCache, NoParams},
    tracing::warn,
};

use tracing::instrument;

use crate::msg::{
    metadata::base_builder::BuildsBaseMetadata,
    pending_message::{ISM_MAX_COUNT, ISM_MAX_DEPTH},
};

use super::{
    aggregation::AggregationIsmMetadataBuilder,
    base::{IsmWithMetadataAndType, MessageMetadataBuildParams, MetadataBuildError},
    ccip_read::CcipReadIsmMetadataBuilder,
    multisig::{MerkleRootMultisigMetadataBuilder, MessageIdMultisigMetadataBuilder},
    null_metadata::NullMetadataBuilder,
    routing::RoutingIsmMetadataBuilder,
    Metadata, MetadataBuilder,
};

/// Builds metadata for a message.
#[derive(Debug, Clone)]
pub struct MessageMetadataBuilder {
    pub base: Arc<dyn BuildsBaseMetadata>,
    pub app_context: Option<String>,
    pub root_ism: H256,
    pub max_ism_depth: u32,
    pub max_ism_count: u32,
}

/// This is the entry point for recursively building ISM metadata.
/// MessageMetadataBuilder acts as the state of the recursion.
/// Recursion works by creating additional Builders that not only impl MetadataBuilder
/// but also takes in an inner MessageMetadataBuilder when instantiated
/// to keep the recursion state.
/// ie. AggregationIsmMetadataBuilder, RoutingIsmMetadataBuilder
/// Logic-wise, it will look something like
/// MessageMetadataBuilder.build()
///   |
///   +-> RoutingIsmMetadataBuilder::new(self.clone()).build()
///         |
///         +-> self.base_builder().build()
///                    |
///                 MessageMetadataBuilder
#[async_trait]
impl MetadataBuilder for MessageMetadataBuilder {
    #[instrument(err, skip(self, message, params), fields(destination_domain=self.base_builder().destination_domain().name()))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        build_message_metadata(self.clone(), ism_address, message, params, None)
            .await
            .map(|res| res.metadata)
    }
}

impl MessageMetadataBuilder {
    pub async fn new(
        base: Arc<dyn BuildsBaseMetadata>,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<Self> {
        let app_context = base
            .app_context_classifier()
            .get_app_context(message, ism_address)
            .await?;
        Ok(Self {
            base,
            app_context,
            root_ism: ism_address,
            max_ism_depth: ISM_MAX_DEPTH,
            max_ism_count: ISM_MAX_COUNT,
        })
    }

    pub fn base_builder(&self) -> &Arc<dyn BuildsBaseMetadata> {
        &self.base
    }

    /// Returns the module type of the ISM.
    /// This method will attempt to get the value from cache first. If it is a cache miss,
    /// it will request it from the ISM contract. The result will be cached for future use.
    ///
    /// Implicit contract in this method: function name `module_type` matches
    /// the name of the method `module_type`.
    async fn call_module_type(
        &self,
        ism: &dyn InterchainSecurityModule,
    ) -> Result<ModuleType, MetadataBuildError> {
        let ism_domain = ism.domain().name();
        let fn_key = "module_type";
        let call_params = (ism.address(), NoParams);

        match self
            .base_builder()
            .cache()
            .get_cached_call_result::<ModuleType>(ism_domain, fn_key, &call_params)
            .await
            .map_err(|err| {
                warn!(error = %err, "Error when caching call result for {:?}", fn_key);
            })
            .ok()
            .flatten()
        {
            Some(module_type) => Ok(module_type),
            None => {
                let module_type = ism
                    .module_type()
                    .await
                    .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

                self.base_builder()
                    .cache()
                    .cache_call_result(ism_domain, fn_key, &call_params, &module_type)
                    .await
                    .map_err(|err| {
                        warn!(error = %err, "Error when caching call result for {:?}", fn_key);
                    })
                    .ok();
                Ok(module_type)
            }
        }
    }
}

pub async fn ism_and_module_type(
    message_builder: MessageMetadataBuilder,
    ism_address: H256,
) -> Result<(Box<dyn InterchainSecurityModule>, ModuleType), MetadataBuildError> {
    let ism = message_builder
        .base_builder()
        .build_ism(ism_address)
        .await
        .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;
    let module_type = message_builder.call_module_type(&ism).await?;
    Ok((ism, module_type))
}

/// Builds metadata for a message.
pub async fn build_message_metadata(
    message_builder: MessageMetadataBuilder,
    ism_address: H256,
    message: &HyperlaneMessage,
    mut params: MessageMetadataBuildParams,
    maybe_ism_and_module_type: Option<(Box<dyn InterchainSecurityModule>, ModuleType)>,
) -> Result<IsmWithMetadataAndType, MetadataBuildError> {
    let (ism, module_type) = match maybe_ism_and_module_type {
        Some((ism, module_type)) => (ism, module_type),
        None => ism_and_module_type(message_builder.clone(), ism_address).await?,
    };
    // check if max depth is reached
    if params.ism_depth >= message_builder.max_ism_depth {
        tracing::error!(
            ism_depth = message_builder.max_ism_depth,
            ism_address = ?ism_address,
            message_id = ?message.id(),
            "Max ISM depth reached",
        );
        return Err(MetadataBuildError::MaxIsmDepthExceeded(
            message_builder.max_ism_depth,
        ));
    }
    params.ism_depth = params.ism_depth.saturating_add(1);
    {
        // check if max ism count is reached
        let mut ism_count = params.ism_count.lock().await;
        if *ism_count >= message_builder.max_ism_count {
            tracing::error!(
                ism_count = message_builder.max_ism_count,
                ism_address = ?ism_address,
                message_id = ?message.id(),
                "Max ISM count reached",
            );
            return Err(MetadataBuildError::MaxIsmCountReached(
                message_builder.max_ism_count,
            ));
        }
        *ism_count = ism_count.saturating_add(1);
    }

    let metadata_builder: Box<dyn MetadataBuilder> = match module_type {
        ModuleType::MerkleRootMultisig => {
            Box::new(MerkleRootMultisigMetadataBuilder::new(message_builder))
        }
        ModuleType::MessageIdMultisig => {
            Box::new(MessageIdMultisigMetadataBuilder::new(message_builder))
        }
        ModuleType::Routing => Box::new(RoutingIsmMetadataBuilder::new(message_builder)),
        ModuleType::Aggregation => Box::new(AggregationIsmMetadataBuilder::new(message_builder)),
        ModuleType::Null => Box::new(NullMetadataBuilder::new()),
        ModuleType::CcipRead => Box::new(CcipReadIsmMetadataBuilder::new(message_builder, None)),
        _ => return Err(MetadataBuildError::UnsupportedModuleType(module_type)),
    };
    let metadata = metadata_builder.build(ism_address, message, params).await?;

    Ok(IsmWithMetadataAndType { ism, metadata })
}

#[cfg(test)]
mod test {
    use std::sync::Arc;

    use hyperlane_base::cache::{
        LocalCache, MeteredCache, MeteredCacheConfig, MeteredCacheMetrics, OptionalCache,
    };
    use hyperlane_core::{
        HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain, Mailbox, ModuleType, H256, U256,
    };
    use hyperlane_test::mocks::MockMailboxContract;
    use prometheus::IntCounterVec;

    use crate::{
        msg::metadata::{
            base::MetadataBuildError, message_builder::build_message_metadata, DefaultIsmCache,
            IsmAwareAppContextClassifier, IsmCachePolicyClassifier, MessageMetadataBuildParams,
        },
        settings::matching_list::{Filter, ListElement, MatchingList},
        test_utils::{
            mock_aggregation_ism::MockAggregationIsm, mock_base_builder::MockBaseMetadataBuilder,
            mock_ism::MockInterchainSecurityModule, mock_routing_ism::MockRoutingIsm,
        },
    };

    use super::MessageMetadataBuilder;

    const TEST_DOMAIN: HyperlaneDomain = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);

    fn dummy_cache_metrics() -> MeteredCacheMetrics {
        MeteredCacheMetrics {
            hit_count: IntCounterVec::new(
                prometheus::Opts::new("dummy_hit_count", "help string"),
                &["cache_name", "chain", "method", "status"],
            )
            .ok(),
            miss_count: IntCounterVec::new(
                prometheus::Opts::new("dummy_miss_count", "help string"),
                &["cache_name", "chain", "method", "status"],
            )
            .ok(),
        }
    }

    fn build_mock_base_builder() -> MockBaseMetadataBuilder {
        let origin_domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism);
        let destination_domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let cache = OptionalCache::new(Some(MeteredCache::new(
            LocalCache::new("test-cache"),
            dummy_cache_metrics(),
            MeteredCacheConfig {
                cache_name: "test-cache".to_owned(),
            },
        )));

        let mut base_builder = MockBaseMetadataBuilder::new();
        base_builder.responses.origin_domain = Some(origin_domain.clone());
        base_builder.responses.destination_domain = Some(destination_domain);
        base_builder.responses.cache = Some(cache);

        let mock_mailbox = MockMailboxContract::new_with_default_ism(H256::zero());
        let mailbox: Arc<dyn Mailbox> = Arc::new(mock_mailbox);
        let default_ism_getter = DefaultIsmCache::new(mailbox);
        let app_context_classifier = IsmAwareAppContextClassifier::new(
            default_ism_getter.clone(),
            vec![(
                MatchingList(Some(vec![ListElement::new(
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                    Filter::Wildcard,
                )])),
                "abcd".to_string(),
            )],
        );
        base_builder.responses.app_context_classifier = Some(app_context_classifier);
        base_builder.responses.ism_cache_policy_classifier = Some(IsmCachePolicyClassifier::new(
            default_ism_getter,
            Default::default(),
        ));
        base_builder
    }

    fn insert_null_isms(base_builder: &MockBaseMetadataBuilder, addresses: &[H256]) {
        for ism_address in addresses {
            let mock_ism = MockInterchainSecurityModule::new(
                *ism_address,
                TEST_DOMAIN.clone(),
                ModuleType::Null,
            );
            mock_ism
                .responses
                .dry_run_verify
                .lock()
                .unwrap()
                .push_back(Ok(Some(U256::zero())));
            base_builder
                .responses
                .push_build_ism_response(*ism_address, Ok(Box::new(mock_ism)));
        }
    }

    fn insert_mock_routing_isms(
        base_builder: &MockBaseMetadataBuilder,
        addresses: &[(H256, H256)],
    ) {
        for (ism_address, route_address) in addresses {
            let mock_ism = MockInterchainSecurityModule::new(
                *ism_address,
                TEST_DOMAIN.clone(),
                ModuleType::Routing,
            );
            mock_ism
                .responses
                .dry_run_verify
                .lock()
                .unwrap()
                .push_back(Ok(Some(U256::zero())));
            base_builder
                .responses
                .push_build_ism_response(*ism_address, Ok(Box::new(mock_ism)));

            let routing_ism = MockRoutingIsm::new(*ism_address, TEST_DOMAIN.clone());
            routing_ism
                .responses
                .route
                .lock()
                .unwrap()
                .push_back(Ok(*route_address));
            base_builder
                .responses
                .push_build_routing_ism_response(*ism_address, Ok(Box::new(routing_ism)));
        }
    }

    fn insert_mock_aggregation_isms(
        base_builder: &MockBaseMetadataBuilder,
        addresses: Vec<(H256, Vec<H256>, u8)>,
    ) {
        for (ism_address, aggregation_addresses, threshold) in addresses {
            let mock_ism = MockInterchainSecurityModule::new(
                ism_address,
                TEST_DOMAIN.clone(),
                ModuleType::Aggregation,
            );
            mock_ism
                .responses
                .dry_run_verify
                .lock()
                .unwrap()
                .push_back(Ok(Some(U256::zero())));
            base_builder
                .responses
                .push_build_ism_response(ism_address, Ok(Box::new(mock_ism)));

            let agg_ism = MockAggregationIsm::new(ism_address, TEST_DOMAIN.clone());
            agg_ism
                .responses
                .modules_and_threshold
                .lock()
                .unwrap()
                .push_back(Ok((aggregation_addresses, threshold)));
            base_builder
                .responses
                .push_build_aggregation_ism_response(ism_address, Ok(Box::new(agg_ism)));
        }
    }

    /// 0
    ///  |
    ///  +---> 100
    ///  |       |
    ///  |       +----> 110 -> 1100
    ///  |       |
    ///  |       +----> 120 -> 1200
    ///  |
    ///  +---> 200
    ///  |       |
    ///  |       +----> 210 -> 2100
    ///  |       |
    ///  |       +----> 0x220 -> 0x2200
    ///  |
    ///  +---> 300
    ///          |
    ///          +----> 310 -> 3100
    ///          |
    ///          +----> 320 -> 3200
    fn insert_ism_test_data(base_builder: &MockBaseMetadataBuilder) {
        insert_mock_aggregation_isms(
            base_builder,
            vec![
                (
                    H256::from_low_u64_be(0),
                    vec![
                        H256::from_low_u64_be(100),
                        H256::from_low_u64_be(200),
                        H256::from_low_u64_be(300),
                    ],
                    2,
                ),
                (
                    H256::from_low_u64_be(100),
                    vec![H256::from_low_u64_be(110), H256::from_low_u64_be(120)],
                    2,
                ),
                (
                    H256::from_low_u64_be(200),
                    vec![H256::from_low_u64_be(210), H256::from_low_u64_be(220)],
                    2,
                ),
                (
                    H256::from_low_u64_be(300),
                    vec![H256::from_low_u64_be(310), H256::from_low_u64_be(320)],
                    2,
                ),
            ],
        );

        insert_mock_routing_isms(
            base_builder,
            &[
                (H256::from_low_u64_be(110), H256::from_low_u64_be(1100)),
                (H256::from_low_u64_be(120), H256::from_low_u64_be(1200)),
                (H256::from_low_u64_be(210), H256::from_low_u64_be(2100)),
                (H256::from_low_u64_be(220), H256::from_low_u64_be(2200)),
                (H256::from_low_u64_be(310), H256::from_low_u64_be(3100)),
                (H256::from_low_u64_be(320), H256::from_low_u64_be(3200)),
            ],
        );

        insert_null_isms(
            base_builder,
            &[
                H256::from_low_u64_be(1100),
                H256::from_low_u64_be(1200),
                H256::from_low_u64_be(2100),
                H256::from_low_u64_be(2200),
                H256::from_low_u64_be(3100),
                H256::from_low_u64_be(3200),
            ],
        );
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn depth_already_reached() {
        let base_builder = build_mock_base_builder();
        insert_null_isms(&base_builder, &[H256::zero()]);

        let ism_address = H256::zero();
        let message = HyperlaneMessage::default();
        let message_builder = {
            let mut builder =
                MessageMetadataBuilder::new(Arc::new(base_builder), ism_address, &message)
                    .await
                    .expect("Failed to build MessageMetadataBuilder");
            builder.max_ism_depth = 0;
            builder
        };
        let params = MessageMetadataBuildParams::default();
        let err =
            build_message_metadata(message_builder, ism_address, &message, params.clone(), None)
                .await
                .expect_err("Metadata found when it should have failed");
        assert_eq!(err, MetadataBuildError::MaxIsmDepthExceeded(0));
        assert_eq!(*(params.ism_count.lock().await), 0);

        assert!(logs_contain("Max ISM depth reached ism_depth=0"));
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn ism_count_already_reached() {
        let base_builder = build_mock_base_builder();
        insert_null_isms(&base_builder, &[H256::zero()]);

        let ism_address = H256::zero();
        let message = HyperlaneMessage::default();

        let message_builder = {
            let mut builder =
                MessageMetadataBuilder::new(Arc::new(base_builder), ism_address, &message)
                    .await
                    .expect("Failed to build MessageMetadataBuilder");
            builder.max_ism_count = 0;
            builder
        };

        let params = MessageMetadataBuildParams::default();
        let err =
            build_message_metadata(message_builder, ism_address, &message, params.clone(), None)
                .await
                .expect_err("Metadata found when it should have failed");
        assert_eq!(err, MetadataBuildError::MaxIsmCountReached(0));
        assert_eq!(*(params.ism_count.lock().await), 0);

        assert!(logs_contain("Max ISM count reached ism_count=0"));
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn max_depth_reached() {
        let base_builder = build_mock_base_builder();
        insert_ism_test_data(&base_builder);

        let ism_address = H256::zero();
        let message = HyperlaneMessage::default();

        let message_builder = {
            let mut builder =
                MessageMetadataBuilder::new(Arc::new(base_builder), ism_address, &message)
                    .await
                    .expect("Failed to build MessageMetadataBuilder");
            builder.max_ism_depth = 2;
            builder
        };

        let params = MessageMetadataBuildParams::default();
        let err =
            build_message_metadata(message_builder, ism_address, &message, params.clone(), None)
                .await
                .expect_err("Metadata found when it should have failed");
        assert_eq!(err, MetadataBuildError::AggregationThresholdNotMet(2));
        assert!(*(params.ism_count.lock().await) <= 4);
        assert!(logs_contain("Max ISM depth reached ism_depth=2"));
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn max_ism_count_reached() {
        let base_builder = build_mock_base_builder();
        insert_ism_test_data(&base_builder);

        let ism_address = H256::zero();
        let message = HyperlaneMessage::default();

        let message_builder = {
            let mut builder =
                MessageMetadataBuilder::new(Arc::new(base_builder), ism_address, &message)
                    .await
                    .expect("Failed to build MessageMetadataBuilder");
            builder.max_ism_count = 5;
            builder
        };

        let params = MessageMetadataBuildParams::default();
        let err =
            build_message_metadata(message_builder, ism_address, &message, params.clone(), None)
                .await
                .expect_err("Metadata found when it should have failed");
        assert_eq!(err, MetadataBuildError::AggregationThresholdNotMet(2));
        assert_eq!(*(params.ism_count.lock().await), 5);
        assert!(logs_contain("Max ISM count reached ism_count=5"));
    }
}
