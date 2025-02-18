use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, H256};
use tracing::{debug, warn};

use crate::msg::metadata::MessageMetadataBuilder;

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct MessageIdMultisigMetadataBuilder(MessageMetadataBuilder);

impl MessageIdMultisigMetadataBuilder {
    /// Returns the merkle leaf id by message id.
    /// This method will attempt to get the value from cache first. If it is a cache miss,
    /// it will request it from merkle tree prover. The result will be cached for future use.
    ///
    /// Implicit contract in this method: function name `get_merkle_leaf_id_by_message_id` matches
    /// the name of the method `get_merkle_leaf_id_by_message_id`.
    async fn call_get_merkle_leaf_id_by_message_id(
        &self,
        message: &HyperlaneMessage,
    ) -> Result<Option<u32>> {
        let domain = self.origin_domain().id();
        let fn_key = format!("get_merkle_leaf_id_by_message_id_{}", domain);
        let message_id = message.id();

        match self
            .get_cached_call_result::<u32>(None, &fn_key, &message_id)
            .await
        {
            Some(index) => Ok(Some(index)),
            None => {
                let index: u32 = unwrap_or_none_result!(
                    self.get_merkle_leaf_id_by_message_id(message_id)
                        .await
                        .context("When fetching merkle leaf index by message id")?,
                    debug!(
                        hyp_message_id=?message_id,
                        "No merkle leaf found for message id, must have not been enqueued in the tree"
                    )
                );

                self.cache_call_result(None, &fn_key, &message_id, &index)
                    .await;
                Ok(Some(index))
            }
        }
    }
}

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

        let leaf_index: u32 =
            unwrap_or_none_result!(self.call_get_merkle_leaf_id_by_message_id(message).await?);

        // Update the validator latest checkpoint metrics.
        let _ = checkpoint_syncer
            .get_validator_latest_checkpoints_and_update_metrics(
                validators,
                self.origin_domain(),
                self.destination_domain(),
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
