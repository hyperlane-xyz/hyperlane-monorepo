use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, H256};

use crate::msg::metadata::BaseMetadataBuilder;

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct LegacyMultisigMetadataBuilder(BaseMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for LegacyMultisigMetadataBuilder {
    fn token_layout(&self) -> Vec<MetadataToken> {
        vec![
            MetadataToken::CheckpointMerkleRoot,
            MetadataToken::CheckpointIndex,
            MetadataToken::CheckpointMerkleTreeHook,
            MetadataToken::MerkleProof,
            MetadataToken::Threshold,
            MetadataToken::Signatures,
            MetadataToken::Validators,
        ]
    }

    async fn fetch_metadata(
        &self,
        validators: &[H256],
        threshold: u8,
        message: &HyperlaneMessage,
        checkpoint_syncer: &MultisigCheckpointSyncer,
    ) -> Result<Option<MultisigMetadata>> {
        const CTX: &str = "When fetching LegacyMultisig metadata";
        unwrap_or_none_result!(highest_leaf_index, self.highest_known_leaf_index().await);
        unwrap_or_none_result!(
            quorum_checkpoint,
            checkpoint_syncer
                .legacy_fetch_checkpoint_in_range(
                    validators,
                    threshold as usize,
                    message.nonce,
                    highest_leaf_index,
                )
                .await
                .context(CTX)?
        );
        unwrap_or_none_result!(
            proof,
            self.get_proof(message.nonce, quorum_checkpoint.checkpoint)
                .await
                .context(CTX)?
        );
        Ok(Some(MultisigMetadata::new(
            quorum_checkpoint.checkpoint,
            quorum_checkpoint.signatures,
            None,
            None,
            Some(proof),
        )))
    }
}
