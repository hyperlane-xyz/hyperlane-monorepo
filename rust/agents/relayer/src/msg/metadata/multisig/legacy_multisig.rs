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
pub struct LegacyMultisigMetadataBuilder(BaseMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for LegacyMultisigMetadataBuilder {
    fn base(&self) -> &BaseMetadataBuilder {
        &self.0
    }

    fn token_layout(&self) -> Vec<MetadataToken> {
        [
            MetadataToken::CheckpointRoot,
            MetadataToken::CheckpointIndex,
            MetadataToken::CheckpointMailbox,
            MetadataToken::MerkleProof,
            MetadataToken::Threshold,
            MetadataToken::Signatures,
            MetadataToken::Validators,
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
        const CTX: &str = "When fetching LegacyMultisig metadata";
        let highest_nonce = self.highest_known_nonce().await;
        if let Some(quorum_checkpoint) = checkpoint_syncer
            .legacy_fetch_checkpoint_in_range(validators, threshold as usize, nonce, highest_nonce)
            .await
            .context(CTX)?
        {
            if let Some(proof) = self
                .get_proof(nonce, quorum_checkpoint.checkpoint)
                .await
                .context(CTX)?
            {
                return Ok(Some(MultisigMetadata::new(
                    quorum_checkpoint.checkpoint,
                    quorum_checkpoint.signatures,
                    None,
                    Some(proof),
                )));
            }
        }
        return Ok(None);
    }
}
