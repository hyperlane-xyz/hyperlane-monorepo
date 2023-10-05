use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{HyperlaneMessage, H256};

use crate::msg::metadata::BaseMetadataBuilder;

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct MerkleRootMultisigMetadataBuilder(BaseMetadataBuilder);
#[async_trait]
impl MultisigIsmMetadataBuilder for MerkleRootMultisigMetadataBuilder {
    fn token_layout(&self) -> Vec<MetadataToken> {
        vec![
            MetadataToken::CheckpointMerkleTreeHook,
            MetadataToken::MessageMerkleLeafIndex,
            MetadataToken::MessageId,
            MetadataToken::MerkleProof,
            MetadataToken::CheckpointIndex,
            MetadataToken::Signatures,
        ]
    }

    async fn fetch_metadata(
        &self,
        validators: &[H256],
        threshold: u8,
        message: &HyperlaneMessage,
        checkpoint_syncer: &MultisigCheckpointSyncer,
    ) -> Result<Option<MultisigMetadata>> {
        const CTX: &str = "When fetching MerkleRootMultisig metadata";
        let Some(highest_nonce) = self.highest_known_nonce().await
        else {
            return Ok(None);
        };
        let Some(quorum_checkpoint) = checkpoint_syncer
            .fetch_checkpoint_in_range(validators, threshold as usize, message.nonce, highest_nonce)
            .await
            .context(CTX)?
        else {
            return Ok(None);
        };

        let Some(proof) = self
            .get_proof(message.nonce, quorum_checkpoint.checkpoint.checkpoint)
            .await
            .context(CTX)?
        else {
            return Ok(None);
        };

        let merkle_leaf_id = self
            .get_merkle_leaf_id_by_message_id(message.id())
            .await
            .context(CTX)?;
        if merkle_leaf_id.is_none() {
            return Ok(None);
        }

        Ok(Some(MultisigMetadata::new(
            quorum_checkpoint.checkpoint.checkpoint,
            quorum_checkpoint.signatures,
            merkle_leaf_id,
            Some(quorum_checkpoint.checkpoint.message_id),
            Some(proof),
        )))
    }
}
