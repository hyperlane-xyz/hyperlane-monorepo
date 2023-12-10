use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;
use ethers::abi::Token;

use ethers::types::H160;
use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{HyperlaneMessage, MultisigSignedCheckpoint, H256};
use strum::Display;
use tracing::{debug, info};

use crate::msg::metadata::BaseMetadataBuilder;
use crate::msg::metadata::MetadataBuilder;

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
pub trait MultisigIsmMetadataBuilder: AsRef<BaseMetadataBuilder> + Send + Sync {
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
    #[allow(clippy::async_yields_async)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        metric_app_context: Option<String>,
    ) -> Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching MultisigIsm metadata";
        let multisig_ism = self
            .as_ref()
            .build_multisig_ism(ism_address)
            .await
            .context(CTX)?;

        let (validators, threshold) = multisig_ism
            .validators_and_threshold(message)
            .await
            .context(CTX)?;

        if validators.is_empty() {
            info!("Could not fetch metadata: No validator set found for ISM");
            return Ok(None);
        }

        let get_latest_index_gauge = metric_app_context.map(|app_context| {
            move |validator: H256| {
                let validator_address = format!("0x{:x}", H160::from(validator));
                // let ism_address = format!("0x{:x}", ism_address);

                // &["origin", "destination", "validator", "app_context", "ism_address"],
                self.as_ref()
                    .metrics
                    .validator_checkpoint_index()
                    .with_label_values(&[
                        &self.as_ref().origin_domain.to_string(),
                        &self.as_ref().destination_chain_setup.domain.to_string(),
                        &validator_address.to_lowercase(),
                        &app_context,
                        // &ism_address,
                    ])
            }
        });
        // let get_latest_index_gauge = None;

        let checkpoint_syncer = self
            .as_ref()
            .build_checkpoint_syncer(&validators, get_latest_index_gauge)
            .await
            .context(CTX)?;

        if let Some(metadata) = self
            .fetch_metadata(&validators, threshold, message, &checkpoint_syncer)
            .await
            .context(CTX)?
        {
            debug!(?message, ?metadata.checkpoint, "Found checkpoint with quorum");
            Ok(Some(self.format_metadata(metadata)?))
        } else {
            info!(
                ?message, ?validators, threshold, ism=%multisig_ism.address(),
                "Could not fetch metadata: Unable to reach quorum"
            );
            Ok(None)
        }
    }
}
