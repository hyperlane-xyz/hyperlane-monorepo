use async_trait::async_trait;
use super::{MetadataBuilder};
use tracing::instrument;
use derive_new::new;

use hyperlane_core::{HyperlaneMessage, H256};

#[derive(Clone, Debug, new)]
pub struct NoMetadataBuilder {}

#[async_trait]
impl MetadataBuilder for NoMetadataBuilder {
    #[instrument(err, skip(self))]
    async fn build(
        &self,
        _ism_address: H256,
        _message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>> {
        Ok(Some(vec![]))
    }
}