use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use hyperlane_base::cache::FunctionCallCache;

use hyperlane_core::{HyperlaneMessage, ModuleType, H256};
use tracing::instrument;

use super::{
    base::MessageMetadataBuildParams, IsmCachePolicy, MessageMetadataBuilder, Metadata,
    MetadataBuildError, MetadataBuilder,
};

#[derive(Clone, Debug, new, Deref)]
pub struct RoutingIsmMetadataBuilder {
    base: MessageMetadataBuilder,
}

#[async_trait]
impl MetadataBuilder for RoutingIsmMetadataBuilder {
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    #[instrument(err, skip(self, message, params))]
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

        let ism_domain = ism.domain().name();
        let message_domain = self.base.base_builder().origin_domain();
        let fn_key = "route";

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

        let module =
            match cache_result {
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
                        self.base_builder().cache().cache_call_result(
                            message_domain.name(),
                            fn_key,
                            &params_cache_key,
                            &module,
                        ).await
                    }
                    IsmCachePolicy::MessageSpecific => {
                        let params_cache_key = (ism.address(), message.id());
                        self.base_builder().cache().cache_call_result(
                            message_domain.name(),
                            fn_key,
                            &params_cache_key,
                            &module,
                        ).await
                    }
                }
                .map_err(|err| {
                    tracing::warn!(error = %err, "Error when caching call result for {:?}", fn_key);
                })
                .ok();
                    module
                }
            };

        self.base.build(module, message, params).await
    }
}
