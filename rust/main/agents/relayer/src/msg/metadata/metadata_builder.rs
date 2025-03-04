use hyperlane_core::{HyperlaneMessage, H256};

use super::Metadata;

#[async_trait::async_trait]
pub trait MetadataBuilder: Send + Sync {
    /// Given a message, build it's ISM metadata
    async fn build(&self, ism_address: H256, message: &HyperlaneMessage) -> eyre::Result<Metadata>;
}
