use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use hyperlane_base::cache::FunctionCallCache;
use tracing::instrument;

use hyperlane_core::{HyperlaneMessage, KnownHyperlaneDomain, ModuleType, H256};

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
    #[instrument(err, skip(self, message), ret)]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
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

        let message_domain = KnownHyperlaneDomain::try_from(message.origin)
            .map(|domain| domain.as_str().to_string())
            // if its an unknown domain, use the raw u32 as a string
            .unwrap_or_else(|_| message.origin.to_string());
        let fn_key = "route";

        // Depending on the cache policy, make use of the message ID
        let params_cache_key = match self
            .base_builder()
            .ism_cache_policy_classifier()
            .get_cache_policy(self.root_ism, ism.domain(), ModuleType::Routing)
            .await
        {
            // To have the cache key be more succinct, we use the message id
            IsmCachePolicy::IsmSpecific => (ism.address(), H256::zero()),
            IsmCachePolicy::MessageSpecific => (ism.address(), message.id()),
        };

        let cache_result: Option<H256> = self
            .base_builder()
            .cache()
            .get_cached_call_result(message_domain.as_str(), fn_key, &params_cache_key)
            .await
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
                self.base_builder()
                    .cache()
                    .cache_call_result(message_domain.as_str(), fn_key, &params_cache_key, &module)
                    .await
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
