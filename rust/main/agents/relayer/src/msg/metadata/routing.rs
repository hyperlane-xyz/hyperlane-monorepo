use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use eyre::Context;
use hyperlane_core::HyperlaneMessage;
use tracing::instrument;

use super::{
    metadata_builder::MessageMetadataBuildParams, MessageMetadataBuilder, Metadata, MetadataBuilder,
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
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> eyre::Result<Metadata> {
        const CTX: &str = "When fetching RoutingIsm metadata";
        let ism = self
            .base_builder()
            .build_routing_ism(params.ism_address)
            .await
            .context(CTX)?;
        let module = ism.route(message).await.context(CTX)?;

        let new_params = MessageMetadataBuildParams {
            ism_address: module,
            ..params
        };
        self.base.build(message, new_params).await.context(CTX)
    }
}
