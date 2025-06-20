use crate::msg::{
    metadata::multisig::{
        MessageIdMultisigMetadataBuilder, MultisigIsmMetadataBuilder, MultisigMetadata,
    },
    metadata::BuildsBaseMetadata,
    metadata::DummyBuildsBaseMetadata,
    metadata::MessageMetadataBuilder,
    metadata::Metadata,
    pending_message::MessageContext,
    pending_message::PendingMessage,
};

use hyperlane_base::kas_hack::logic_loop::MetadataConstructor;
use hyperlane_core::{
    traits::PendingOperationResult, AggregationIsm, CcipReadIsm, Checkpoint, HyperlaneDomain,
    HyperlaneMessage, InterchainSecurityModule, MultisigIsm, MultisigSignedCheckpoint, RoutingIsm,
    H256,
};
use std::sync::Arc;

use eyre::Result;

pub struct PendingMessageMetadataGetter {
    builder: MessageIdMultisigMetadataBuilder,
}

impl PendingMessageMetadataGetter {
    pub fn new(builder: MessageIdMultisigMetadataBuilder) -> Self {
        Self { builder }
    }
    pub fn new_alt() -> Self {
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

impl MetadataConstructor for PendingMessageMetadataGetter {
    fn metadata(&self, checkpoint: &MultisigSignedCheckpoint) -> Result<Vec<u8>> {
        // now mimic https://github.com/dymensionxyz/hyperlane-monorepo/blob/f4836a2a7291864d0c1850dbbcecd6af54addce3/rust/main/agents/relayer/src/msg/metadata/multisig/base.rs#L226-L235
        let meta: MultisigMetadata = MultisigMetadata::new(*checkpoint, 0, None);

        let formatter = self.builder.as_ref() as &dyn MultisigIsmMetadataBuilder;
        formatter.format_metadata(meta)
    }
}
