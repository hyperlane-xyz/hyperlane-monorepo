use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::H256;

use crate::msg::metadata::BaseMetadataBuilder;

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};

#[derive(Debug, Clone, Deref, new)]
pub struct MessageIdMultisigMetadataBuilder(BaseMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for MessageIdMultisigMetadataBuilder {
    fn base(&self) -> &BaseMetadataBuilder {
        &self.0
    }

    fn token_layout(&self) -> Vec<MetadataToken> {
        [
            MetadataToken::CheckpointMailbox,
            MetadataToken::CheckpointRoot,
            MetadataToken::Signatures,
        ]
        .to_vec()
    }

    async fn fetch_metadata(
        &self,
        nonce: u32,
        validators: &[H256],
        threshold: u8,
        checkpoint_syncer: &MultisigCheckpointSyncer,
    ) -> Result<Option<MultisigMetadata>> {
        const CTX: &str = "When fetching MessageIdMultisig metadata";
        if let Some(quorum_checkpoint) = checkpoint_syncer
            .fetch_checkpoint(validators, threshold as usize, nonce)
            .await
            .context(CTX)?
        {
            Ok(Some(MultisigMetadata::new(
                quorum_checkpoint.checkpoint.checkpoint,
                quorum_checkpoint.signatures,
                None,
                None,
            )))
        } else {
            Ok(None)
        }
    }
}
