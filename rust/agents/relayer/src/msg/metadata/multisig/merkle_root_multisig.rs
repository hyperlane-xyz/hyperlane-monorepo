use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{H256, HyperlaneMessage};
use tracing::warn;

use crate::msg::metadata::BaseMetadataBuilder;

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};

#[derive(Debug, Clone, Deref, new)]
pub struct MerkleRootMultisigMetadataBuilder(BaseMetadataBuilder);
#[async_trait]
impl MultisigIsmMetadataBuilder for MerkleRootMultisigMetadataBuilder {
    fn base(&self) -> &BaseMetadataBuilder {
        &self.0
    }

    fn token_layout(&self) -> Vec<MetadataToken> {
        [
            MetadataToken::CheckpointMailbox,
            MetadataToken::CheckpointIndex,
            MetadataToken::MessageId,
            MetadataToken::MerkleProof,
            MetadataToken::Signatures,
        ]
        .to_vec()
    }

    async fn fetch_metadata(
        &self,
        validators: &[H256],
        threshold: u8,
        message: &HyperlaneMessage,
        checkpoint_syncer: &MultisigCheckpointSyncer,
    ) -> Result<Option<MultisigMetadata>> {
        const CTX: &str = "When fetching MerkleRootMultisig metadata";
        let highest_nonce = self.highest_known_nonce().await;
        if let Some(quorum_checkpoint) = checkpoint_syncer
            .fetch_checkpoint_in_range(validators, threshold as usize, message.nonce, highest_nonce)
            .await
            .context(CTX)?
        {
            if quorum_checkpoint.checkpoint.message_id != message.id() {
                warn!(
                    "Quorum checkpoint message id {} does not match message id {}",
                    quorum_checkpoint.checkpoint.message_id,
                    message.id()
                );
                return Ok(None);
            }

            if let Some(proof) = self
                .get_proof(message.nonce, quorum_checkpoint.checkpoint.checkpoint)
                .await
                .context(CTX)?
            {
                return Ok(Some(MultisigMetadata::new(
                    quorum_checkpoint.checkpoint.checkpoint,
                    quorum_checkpoint.signatures,
                    Some(quorum_checkpoint.checkpoint.message_id),
                    Some(proof),
                )));
            }
        }
        return Ok(None);
    }
}
