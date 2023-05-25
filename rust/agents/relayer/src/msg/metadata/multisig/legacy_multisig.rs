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
pub struct LegacyMultisigMetadataBuilder(BaseMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for LegacyMultisigMetadataBuilder {
    fn token_layout(&self) -> Vec<MetadataToken> {
        vec![
            MetadataToken::CheckpointRoot,
            MetadataToken::CheckpointIndex,
            MetadataToken::CheckpointMailbox,
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
        let highest_nonce = self.highest_known_nonce().await;
        let Some(quorum_checkpoint) = checkpoint_syncer
            .legacy_fetch_checkpoint_in_range(
                validators,
                threshold as usize,
                message.nonce,
                highest_nonce,
            )
            .await
            .context(CTX)?
        else {
            return Ok(None);
        };

        let Some(proof) = self
            .get_proof(message.nonce, quorum_checkpoint.checkpoint)
            .await
            .context(CTX)?
        else {
            return Ok(None);
        };

        Ok(Some(MultisigMetadata::new(
            quorum_checkpoint.checkpoint,
            quorum_checkpoint.signatures,
            None,
            Some(proof),
        )))
    }
}
