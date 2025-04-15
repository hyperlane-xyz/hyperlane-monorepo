use std::time::Instant;

use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use tracing::instrument;

use hyperlane_core::{HyperlaneMessage, H256};

use crate::msg::log_times;

use super::{
    base::MessageMetadataBuildParams, MessageMetadataBuilder, Metadata, MetadataBuildError,
    MetadataBuilder,
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
        let start = Instant::now();
        let ism = self
            .base_builder()
            .build_routing_ism(ism_address)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;
        log_times("RoutingISM: build", start.elapsed());

        let start = Instant::now();
        let module = ism
            .route(message)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;
        log_times("RoutingISM: route", start.elapsed());

        self.base.build(module, message, params).await
    }
}
