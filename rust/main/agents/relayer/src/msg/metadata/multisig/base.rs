use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;
use ethers::abi::Token;

use eyre::{Context, Result};
use hyperlane_base::settings::CheckpointSyncerBuildError;
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{HyperlaneMessage, MultisigSignedCheckpoint, H256};
use strum::Display;
use tracing::{debug, info};

use crate::msg::metadata::base::MetadataBuildError;
use crate::msg::metadata::message_builder::MessageMetadataBuilder;
use crate::msg::metadata::{MessageMetadataBuildParams, Metadata, MetadataBuilder};

#[derive(new, AsRef, Deref)]
pub struct MultisigMetadata {
    #[deref]
    quorum_checkpoint: MultisigSignedCheckpoint,
    merkle_leaf_index: u32,
    // optional because it's only used for MerkleRootMultisig
    proof: Option<Proof>,
}

#[derive(Debug, Display, PartialEq, Eq, Clone)]
pub enum MetadataToken {
    CheckpointMerkleRoot,
    CheckpointIndex,
    CheckpointMerkleTreeHook,
    MessageId,
    MerkleProof,
    MessageMerkleLeafIndex,
    Signatures,
}

#[async_trait]
pub trait MultisigIsmMetadataBuilder: AsRef<MessageMetadataBuilder> + Send + Sync {
    async fn fetch_metadata(
        &self,
        validators: &[H256],
        threshold: u8,
        message: &HyperlaneMessage,
        checkpoint_syncer: &MultisigCheckpointSyncer,
    ) -> Result<Option<MultisigMetadata>>;

    fn token_layout(&self) -> Vec<MetadataToken>;

    fn format_metadata(&self, metadata: MultisigMetadata) -> Result<Vec<u8>> {
        let build_token = |token: &MetadataToken| -> Result<Vec<u8>> {
            match token {
                MetadataToken::CheckpointMerkleRoot => {
                    Ok(metadata.checkpoint.root.to_fixed_bytes().into())
                }
                MetadataToken::MessageMerkleLeafIndex => {
                    Ok(metadata.merkle_leaf_index.to_be_bytes().into())
                }
                MetadataToken::CheckpointIndex => {
                    Ok(metadata.checkpoint.index.to_be_bytes().into())
                }
                MetadataToken::CheckpointMerkleTreeHook => Ok(metadata
                    .checkpoint
                    .merkle_tree_hook_address
                    .to_fixed_bytes()
                    .into()),
                MetadataToken::MessageId => {
                    Ok(metadata.checkpoint.message_id.to_fixed_bytes().into())
                }
                MetadataToken::MerkleProof => {
                    let proof_tokens: Vec<Token> = metadata
                        .proof
                        .unwrap()
                        .path
                        .iter()
                        .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
                        .collect();
                    Ok(ethers::abi::encode(&proof_tokens))
                }
                MetadataToken::Signatures => Ok(metadata
                    .signatures
                    .iter()
                    .map(|x| x.to_vec())
                    .collect::<Vec<_>>()
                    .concat()),
            }
        };
        let metas: Result<Vec<Vec<u8>>> = self.token_layout().iter().map(build_token).collect();
        Ok(metas?.into_iter().flatten().collect())
    }
}

#[async_trait]
impl<T: MultisigIsmMetadataBuilder> MetadataBuilder for T {
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        _params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        const CTX: &str = "When fetching MultisigIsm metadata";
        let multisig_ism = self
            .as_ref()
            .base_builder()
            .build_multisig_ism(ism_address)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

        let (validators, threshold) = multisig_ism
            .validators_and_threshold(message)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

        if validators.is_empty() {
            info!("Could not fetch metadata: No validator set found for ISM");
            return Err(MetadataBuildError::CouldNotFetch);
        }

        info!(hyp_message=?message, ?validators, threshold, "List of validators and threshold for message");

        let checkpoint_syncer = match self
            .as_ref()
            .base_builder()
            .build_checkpoint_syncer(message, &validators, self.as_ref().app_context.clone())
            .await
        {
            Ok(syncer) => syncer,
            Err(CheckpointSyncerBuildError::ReorgEvent(reorg_event)) => {
                let err = MetadataBuildError::Refused(format!(
                    "A reorg event occurred {:?}",
                    reorg_event
                ));
                return Err(err);
            }
            Err(e) => {
                let err = MetadataBuildError::FailedToBuild(e.to_string());
                return Err(err);
            }
        };

        if let Some(metadata) = self
            .fetch_metadata(&validators, threshold, message, &checkpoint_syncer)
            .await
            .context(CTX)
            .map_err(|_| MetadataBuildError::CouldNotFetch)?
        {
            debug!(hyp_message=?message, ?metadata.checkpoint, "Found checkpoint with quorum");
            let formatted = self
                .format_metadata(metadata)
                .map_err(|_| MetadataBuildError::CouldNotFetch)?;
            Ok(Metadata::new(formatted))
        } else {
            info!(
                hyp_message=?message, ?validators, threshold, ism=%multisig_ism.address(),
                "Could not fetch metadata: Unable to reach quorum"
            );
            Err(MetadataBuildError::CouldNotFetch)
        }
    }
}
