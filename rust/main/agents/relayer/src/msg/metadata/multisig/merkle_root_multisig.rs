use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::{cache::NoParams, MultisigCheckpointSyncer};
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, H256};
use tracing::debug;

use crate::msg::metadata::MessageMetadataBuilder;

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct MerkleRootMultisigMetadataBuilder(MessageMetadataBuilder);
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

        let fn_name = "highest_known_leaf_index";
        let highest_leaf_index = match self
            .get_cached_call_result::<u32>(None, fn_name, &NoParams)
            .await
        {
            Some(index) => index,
            None => {
                let index: u32 = unwrap_or_none_result!(
                    self.highest_known_leaf_index().await,
                    debug!("Couldn't get highest known leaf index")
                );

                self.cache_call_result(None, fn_name, &NoParams, &index)
                    .await;
                index
            }
        };

        // let highest_leaf_index = unwrap_or_none_result!(
        //     self.highest_known_leaf_index().await,
        //     debug!("Couldn't get highest known leaf index")
        // );

        let fn_name = "get_merkle_leaf_id_by_message_id";
        let leaf_index = match self
            .get_cached_call_result::<u32>(None, fn_name, &message.id())
            .await
        {
            Some(index) => index,
            None => {
                let index: u32 = unwrap_or_none_result!(
                    self.get_merkle_leaf_id_by_message_id(message.id())
                        .await
                        .context(CTX)?,
                    debug!(
                        hyp_message=?message,
                        "No merkle leaf found for message id, must have not been enqueued in the tree"
                    )
                );

                self.cache_call_result(None, fn_name, &message.id(), &index)
                    .await;
                index
            }
        };

        // let leaf_index = unwrap_or_none_result!(
        //     self.get_merkle_leaf_id_by_message_id(message.id())
        //         .await
        //         .context(CTX)?,
        //     debug!(
        //         hyp_message=?message,
        //         "No merkle leaf found for message id, must have not been enqueued in the tree"
        //     )
        // );
        let quorum_checkpoint = unwrap_or_none_result!(
            checkpoint_syncer
                .fetch_checkpoint_in_range(
                    validators,
                    threshold as usize,
                    leaf_index,
                    highest_leaf_index,
                    self.origin_domain(),
                    self.destination_domain(),
                )
                .await
                .context(CTX)?,
            debug!(
                leaf_index,
                highest_leaf_index, "Couldn't get checkpoint in range"
            )
        );
        let proof = self
            .get_proof(leaf_index, quorum_checkpoint.checkpoint.checkpoint)
            .await
            .context(CTX)?;
        Ok(Some(MultisigMetadata::new(
            quorum_checkpoint,
            leaf_index,
            Some(proof),
        )))
    }
}
