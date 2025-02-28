use hyperlane_core::{HyperlaneMessage, H256};

use super::Metadata;

/// Metadata build parameters
#[derive(Clone, Debug)]
pub struct MessageMetadataBuildParams {
    pub ism_address: H256,
    pub options: MessageMetadataBuildOptions,
}

impl MessageMetadataBuildParams {
    pub fn new(ism_address: H256, max_depth: u32, max_ism_count: u32) -> Self {
        Self {
            ism_address,
            options: MessageMetadataBuildOptions {
                max_depth,
                max_ism_count,
            },
        }
    }
}

/// Metadata build parameter options
#[derive(Clone, Debug)]
pub struct MessageMetadataBuildOptions {
    /// Maximum depth of ISMs to process for each message
    pub max_depth: u32,
    /// Maximum number of ISM to process for each message
    pub max_ism_count: u32,
}

#[async_trait::async_trait]
pub trait MetadataBuilder: Send + Sync {
    /// Given a message, build it's ISM metadata
    async fn build(
        &self,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> eyre::Result<Metadata>;
}
