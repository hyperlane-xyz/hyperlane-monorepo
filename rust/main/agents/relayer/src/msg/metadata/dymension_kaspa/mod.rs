use async_trait::async_trait;
use tracing::{info, instrument, warn};

use super::{
    base::{MessageMetadataBuildParams, MetadataBuildError},
    message_builder::MessageMetadataBuilder,
    Metadata, MetadataBuilder,
};
use crate::msg::{
    metadata::multisig::{
        MessageIdMultisigMetadataBuilder, MultisigIsmMetadataBuilder, MultisigMetadata,
    },
    metadata::DummyBuildsBaseMetadata,
};
use hyperlane_core::{
    utils::bytes_to_hex, CcipReadIsm, HyperlaneMessage, HyperlaneSignerExt, RawHyperlaneMessage,
    Signable, H160, H256,
};

use hyperlane_base::kas_hack::logic_loop::MetadataConstructor;
use hyperlane_core::MultisigSignedCheckpoint;
use std::sync::Arc;
pub struct KaspaMetadataBuilder;

impl KaspaMetadataBuilder {
    pub fn new(message_builder: MessageMetadataBuilder) -> Self {
        Self {}
    }
}

#[async_trait]
impl MetadataBuilder for KaspaMetadataBuilder {
    #[instrument(err, skip(self, message, _params))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        _params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        /*
        Our Kaspa bridge design doesn't match perfectly with the Hyperlane relayer pattern.
        The hyperlane relayer pattern gathers metadata (i.e. validator signatures) for each message individually,
        and submits them one at a time to the destination chain.
        There IS an optional way to submit messages in batches, but there is no way to gather gather metadata in a batch.

        We want to construct a batch of txs which contain possibly many hyperlane messages at once.
        Therefore we return a dummy metadata, and then we ignore it later, and construct everything on the fly during submission.
        */
        Ok(Metadata::new(vec![]))
    }
}

use eyre::Result;

impl MetadataConstructor for PendingMessageMetadataGetter {
    /// mimic https://github.com/dymensionxyz/hyperlane-monorepo/blob/f4836a2a7291864d0c1850dbbcecd6af54addce3/rust/main/agents/relayer/src/msg/metadata/multisig/base.rs#L226-L235
    fn metadata(&self, checkpoint: &MultisigSignedCheckpoint) -> Result<Vec<u8>> {
        let d: MultisigMetadata = MultisigMetadata::new(checkpoint.clone(), 0, None);
        let formatter = &self.builder as &dyn MultisigIsmMetadataBuilder;
        formatter.format_metadata(d)
    }
}

/// A convenience way to properly format signature metadata, without requiring a huge amount of unused context objects
pub struct PendingMessageMetadataGetter {
    builder: MessageIdMultisigMetadataBuilder,
}

impl PendingMessageMetadataGetter {
    pub fn new() -> Self {
        Self {
            builder: MessageIdMultisigMetadataBuilder::new(MessageMetadataBuilder {
                base: Arc::new(DummyBuildsBaseMetadata),
                app_context: None,
                root_ism: H256::random(),
                max_ism_depth: 0,
                max_ism_count: 0,
            }),
        }
    }
}
