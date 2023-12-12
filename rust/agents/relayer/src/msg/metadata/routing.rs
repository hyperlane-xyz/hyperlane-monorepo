use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use eyre::Context;
use hyperlane_core::{HyperlaneMessage, H256};
use tracing::instrument;

use super::{base::MessageBaseMetadataBuilder, BaseMetadataBuilder, MetadataBuilder};

#[derive(Clone, Debug, new, Deref)]
pub struct RoutingIsmMetadataBuilder {
    base: MessageBaseMetadataBuilder,
}

#[async_trait]
impl MetadataBuilder for RoutingIsmMetadataBuilder {
    #[instrument(err, skip(self))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        metric_app_context: Option<String>,
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching RoutingIsm metadata";
        let ism = self
            .base
            .base
            .build_routing_ism(ism_address)
            .await
            .context(CTX)?;
        let module = ism.route(message).await.context(CTX)?;
        self.base
            .base
            .build(module, message, metric_app_context)
            .await
            .context(CTX)
    }
}
