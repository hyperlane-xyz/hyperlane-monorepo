use super::MetadataBuilder;
use async_trait::async_trait;
use derive_new::new;
use tracing::instrument;

use hyperlane_core::{HyperlaneMessage, H256};

#[derive(Clone, Debug, new)]
pub struct NullMetadataBuilder {}

#[async_trait]
impl MetadataBuilder for NullMetadataBuilder {
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    #[instrument(err, skip(self))]
    async fn build(
        &self,
        _ism_address: H256,
        _message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>> {
        Ok(Some(vec![]))
    }
}
