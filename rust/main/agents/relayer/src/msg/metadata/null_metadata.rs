use async_trait::async_trait;
use derive_new::new;

use hyperlane_core::{HyperlaneMessage, H256};

use super::{MessageMetadataBuildParams, Metadata, MetadataBuildError, MetadataBuilder};

#[derive(Clone, Debug, new)]
pub struct NullMetadataBuilder {}

#[async_trait]
impl MetadataBuilder for NullMetadataBuilder {
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn build(
        &self,
        _ism_address: H256,
        _message: &HyperlaneMessage,
        _params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        Ok(Metadata::new(vec![]))
    }
}
