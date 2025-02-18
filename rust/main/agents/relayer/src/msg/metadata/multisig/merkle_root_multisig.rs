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

impl MerkleRootMultisigMetadataBuilder {
    /// Returns highest known leaf index.
    /// This method will attempt to get the value from cache first. If it is a cache miss,
    /// it will request it from merkle tree prover. The result will be cached for future use.
    ///
    /// Implicit contract in this method: function name `highest_known_leaf_index` matches
    /// the name of the method `highest_known_leaf_index`.
    async fn call_highest_known_leaf_index(&self) -> Result<Option<u32>> {
        let domain = self.origin_domain().id();
        let fn_key = format!("highest_known_leaf_index_{}", domain);

        match self
            .get_cached_call_result::<u32>(None, &fn_key, &NoParams)
            .await
        {
            Some(index) => Ok(Some(index)),
            None => {
                let index: u32 = unwrap_or_none_result!(
                    self.highest_known_leaf_index().await,
                    debug!("Couldn't get highest known leaf index")
                );

                self.cache_call_result(None, &fn_key, &NoParams, &index)
                    .await;
                Ok(Some(index))
            }
        }
    }

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

        let highest_leaf_index: u32 =
            unwrap_or_none_result!(self.call_highest_known_leaf_index().await?);

        let leaf_index: u32 =
            unwrap_or_none_result!(self.call_get_merkle_leaf_id_by_message_id(message).await?);

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
