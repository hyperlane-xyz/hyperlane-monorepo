use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, ModuleType, H256};
use tracing::debug;

use crate::msg::metadata::{MessageMetadataBuilder, MetadataBuildError};

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct MerkleRootMultisigMetadataBuilder(MessageMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for MerkleRootMultisigMetadataBuilder {
    fn module_type(&self) -> ModuleType {
        ModuleType::MerkleRootMultisig
    }

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
    ) -> Result<Option<MultisigMetadata>, MetadataBuildError> {
        let highest_leaf_index = unwrap_or_none_result!(
            self.base_builder().highest_known_leaf_index().await,
            debug!("Couldn't get highest known leaf index")
        );
        let leaf_index = unwrap_or_none_result!(
            self.base_builder()
                .get_merkle_leaf_id_by_message_id(message.id())
                .await
                .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?,
            debug!(
                hyp_message=?message,
                "No merkle leaf found for message id, must have not been enqueued in the tree"
            )
        );
        let quorum_checkpoint = unwrap_or_none_result!(
            checkpoint_syncer
                .fetch_checkpoint_in_range(
                    validators,
                    threshold as usize,
                    leaf_index,
                    highest_leaf_index,
                    self.base_builder().origin_domain(),
                    self.base_builder().destination_domain(),
                )
                .await
                .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?,
            debug!(
                leaf_index,
                highest_leaf_index, "Couldn't get checkpoint in range"
            )
        );
        let proof = self
            .base_builder()
            .get_proof(leaf_index, quorum_checkpoint.checkpoint.checkpoint)
            .await?;
        Ok(Some(MultisigMetadata::new(
            quorum_checkpoint,
            leaf_index,
            Some(proof),
        )))
    }
}
