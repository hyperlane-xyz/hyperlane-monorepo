use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;
use ethers::abi::Token;

use eyre::{Context, Result};
use hyperlane_base::{MultisigCheckpointSyncer, ValidatorWithWeight, Weight};
use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{HyperlaneMessage, MultisigSignedCheckpoint, H256};
use strum::Display;
use tracing::{debug, info};

use crate::msg::metadata::base::MessageMetadataBuilder;

use crate::msg::metadata::MetadataBuilder;

#[derive(new, AsRef, Deref)]
pub struct MultisigMetadata {
    #[deref]
    quorum_checkpoint: MultisigSignedCheckpoint,
    merkle_leaf_index: u32,
    // optional because it's only used for MerkleRootMultisig
    proof: Option<Proof>,
}

pub(crate) async fn fetch_unit_validator_requirements(
    builder: &impl AsRef<MessageMetadataBuilder>,
    ism_address: H256,
    message: &HyperlaneMessage,
) -> Result<(Vec<ValidatorWithWeight>, Weight)> {
    const CTX: &str = "When fetching MultisigIsm metadata";
    let multisig_ism = builder
        .as_ref()
        .build_multisig_ism(ism_address)
        .await
        .context(CTX)?;

    let (validators, threshold) = multisig_ism
        .validators_and_threshold(message)
        .await
        .context(CTX)?;

    let unit_validators: Vec<ValidatorWithWeight> = validators
        .into_iter()
        .map(|v| ValidatorWithWeight::new(v, 1))
        .collect();

    Ok((unit_validators, threshold.into()))
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
        validators: &[ValidatorWithWeight],
        threshold: Weight,
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

    async fn ism_validator_requirements(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<(Vec<ValidatorWithWeight>, Weight)>;
}

#[async_trait]
impl<T: MultisigIsmMetadataBuilder> MetadataBuilder for T {
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching MultisigIsm metadata";

        let (weighted_validators, threshold_weight) = self
            .ism_validator_requirements(ism_address, message)
            .await?;

        if weighted_validators.is_empty() {
            info!("Could not fetch metadata: No validator set found for ISM");
            return Ok(None);
        }

        let validators: Vec<H256> = weighted_validators.iter().map(|vw| vw.validator).collect();

        let checkpoint_syncer = self
            .as_ref()
            .build_checkpoint_syncer(&validators, self.as_ref().app_context.clone())
            .await
            .context(CTX)?;

        if let Some(metadata) = self
            .fetch_metadata(
                &weighted_validators,
                threshold_weight,
                message,
                &checkpoint_syncer,
            )
            .await
            .context(CTX)?
        {
            debug!(?message, ?metadata.checkpoint, "Found checkpoint with quorum");
            Ok(Some(self.format_metadata(metadata)?))
        } else {
            info!(
                ?message, ?weighted_validators, threshold_weight, ism=%ism_address,
                "Could not fetch metadata: Unable to reach quorum"
            );
            Ok(None)
        }
    }
}
