use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use eyre::Context;
use hyperlane_core::{HyperlaneMessage, H256};
use tracing::instrument;

use super::{MessageMetadataBuilder, MetadataBuilder};

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
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching RoutingIsm metadata";
        let ism = self.build_routing_ism(ism_address).await.context(CTX)?;
        let module = ism.route(message).await.context(CTX)?;
        self.base.build(module, message).await.context(CTX)
    }
}
