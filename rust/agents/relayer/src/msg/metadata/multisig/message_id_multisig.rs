use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, H256};
use tracing::{debug, trace, warn};

use crate::msg::metadata::BaseMetadataBuilder;

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct MessageIdMultisigMetadataBuilder(BaseMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for MessageIdMultisigMetadataBuilder {
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
        unwrap_or_none_result!(
            leaf_index,
            self.get_merkle_leaf_id_by_message_id(message_id)
                .await
                .context(CTX)?,
            debug!(
                ?message,
                "No merkle leaf found for message id, must have not been enqueued in the tree"
            )
        );
        unwrap_or_none_result!(
            quorum_checkpoint,
            checkpoint_syncer
                .fetch_checkpoint(validators, threshold as usize, leaf_index)
                .await
                .context(CTX)?,
            trace!("No quorum checkpoint found")
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
