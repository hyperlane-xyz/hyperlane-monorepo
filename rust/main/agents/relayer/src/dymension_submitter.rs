use crate::msg::{
    metadata::Metadata, pending_message::MessageContext, pending_message::PendingMessage,
    metadata::multisig::MessageIdMultisigMetadataBuilder,
};

use hyperlane_core::{traits::PendingOperationResult, HyperlaneMessage, MultisigSignedCheckpoint};
use std::sync::Arc;

use eyre::Result;

struct PendingMessageMedataConstructor{
    builder: MessageIdMultisigMetadataBuilder,
}

impl PendingMessageMedataConstructor {
    pub fn metadata(
        &self,
        checkpoint: MultisigSignedCheckpoint,
    ) -> Result<Vec<u8>> {

        // now mimic https://github.com/dymensionxyz/hyperlane-monorepo/blob/f4836a2a7291864d0c1850dbbcecd6af54addce3/rust/main/agents/relayer/src/msg/metadata/multisig/base.rs#L226-L235
        let meta : MultisigMetadata = MultisigMetadata::new(
            checkpoint,
            0,
            None,
        );
        Ok(meta.to_vec().as_slice())
    }
}
