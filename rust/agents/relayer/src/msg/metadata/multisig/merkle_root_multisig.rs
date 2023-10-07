use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, H256};
use tracing::debug;

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
        unwrap_or_none_result!(
            highest_leaf_index,
            self.highest_known_leaf_index().await,
            debug!("Couldn't get highest known leaf index")
        );
        unwrap_or_none_result!(
            quorum_checkpoint,
            checkpoint_syncer
                .fetch_checkpoint_in_range(
                    validators,
                    threshold as usize,
                    message.nonce,
                    highest_leaf_index
                )
                .await
                .context(CTX)?,
            debug!("Couldn't get checkpoint in range")
        );
        unwrap_or_none_result!(
            proof,
            self.get_proof(message.nonce, quorum_checkpoint.checkpoint.checkpoint)
                .await
                .context(CTX)?
        );
        unwrap_or_none_result!(
            merkle_leaf_id,
            self.get_merkle_leaf_id_by_message_id(message.id())
                .await
                .context(CTX)?,
            debug!("Couldn't get merkle proof")
        );
        Ok(Some(MultisigMetadata::new(
            quorum_checkpoint.checkpoint.checkpoint,
            quorum_checkpoint.signatures,
            Some(merkle_leaf_id),
            Some(quorum_checkpoint.checkpoint.message_id),
            Some(proof),
        )))
    }
}
