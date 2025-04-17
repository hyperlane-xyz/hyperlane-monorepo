use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, ModuleType, H256};
use tracing::{debug, warn};

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};
use crate::msg::metadata::MessageMetadataBuilder;

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct MessageIdMultisigMetadataBuilder(MessageMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for MessageIdMultisigMetadataBuilder {
    fn module_type(&self) -> ModuleType {
        ModuleType::MessageIdMultisig
    }

    fn token_layout(&self) -> Vec<MetadataToken> {
        vec![
            MetadataToken::CheckpointMerkleTreeHook,
            MetadataToken::CheckpointMerkleRoot,
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
        let message_id = message.id();
        const CTX: &str = "When fetching MessageIdMultisig metadata";
        let leaf_index = unwrap_or_none_result!(
            self.base_builder()
                .get_merkle_leaf_id_by_message_id(message_id)
                .await
                .context(CTX)?,
            debug!(
                hyp_message=?message,
                "No merkle leaf found for message id, must have not been enqueued in the tree"
            )
        );

        // Update the validator latest checkpoint metrics.
        let _ = checkpoint_syncer
            .get_validator_latest_checkpoints_and_update_metrics(
                validators,
                self.base_builder().origin_domain(),
                self.base_builder().destination_domain(),
            )
            .await;

        let quorum_checkpoint = unwrap_or_none_result!(
            checkpoint_syncer
                .fetch_checkpoint(validators, threshold as usize, leaf_index)
                .await
                .context(CTX)?,
            debug!("No quorum checkpoint found")
        );

        if quorum_checkpoint.checkpoint.message_id != message_id {
            warn!(
                "Quorum checkpoint message id {} does not match message id {}",
                quorum_checkpoint.checkpoint.message_id, message_id
            );
            if quorum_checkpoint.checkpoint.index != leaf_index {
                warn!(
                    "Quorum checkpoint index {} does not match leaf index {}",
                    quorum_checkpoint.checkpoint.index, leaf_index
                );
            }
            return Ok(None);
        }

        Ok(Some(MultisigMetadata::new(
            quorum_checkpoint,
            leaf_index,
            None,
        )))
    }
}
