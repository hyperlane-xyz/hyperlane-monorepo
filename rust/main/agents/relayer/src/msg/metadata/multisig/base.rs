use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;
use ethers::abi::Token;

use eyre::{Context, Result};
use hyperlane_base::settings::CheckpointSyncerBuildError;
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{HyperlaneMessage, MultisigIsm, MultisigSignedCheckpoint, H256};
use strum::Display;
use tracing::{debug, info};

use crate::msg::metadata::base::MessageMetadataBuilder;

use crate::msg::metadata::{Metadata, MetadataBuilder};

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

    /// Returns the validators and threshold for the given multisig ISM.
    /// This method will attempt to get the value from cache first. If it is a cache miss,
    /// it will request it from ISM contract. The result will be cached for future use.
    ///
    /// Implicit contract in this method: function name `validators_and_threshold` matches
    /// the name of the method `validators_and_threshold`.
    async fn call_validators_and_threshold(
        &self,
        multisig_ism: &dyn MultisigIsm,
        message: &HyperlaneMessage,
        context: &'static str,
    ) -> Result<(Vec<H256>, u8)> {
        let contract_address = Some(multisig_ism.address());
        let ism_domain = multisig_ism.domain().id();
        let fn_key = format!("validators_and_threshold_{}", ism_domain);

        match self
            .as_ref()
            .get_cached_call_result::<(Vec<H256>, u8)>(contract_address, &fn_key, message)
            .await
        {
            Some(result) => Ok(result),
            None => {
                let result = multisig_ism
                    .validators_and_threshold(message)
                    .await
                    .context(context)?;

                self.as_ref()
                    .cache_call_result(contract_address, &fn_key, message, &result)
                    .await;
                Ok(result)
            }
        }
    }
}

#[async_trait]
impl<T: MultisigIsmMetadataBuilder> MetadataBuilder for T {
    async fn build(&self, ism_address: H256, message: &HyperlaneMessage) -> Result<Metadata> {
        const CTX: &str = "When fetching MultisigIsm metadata";
        let multisig_ism = self
            .as_ref()
            .build_multisig_ism(ism_address)
            .await
            .context(CTX)?;

        let (validators, threshold) = self
            .call_validators_and_threshold(&multisig_ism, message, CTX)
            .await?;

        if validators.is_empty() {
            info!("Could not fetch metadata: No validator set found for ISM");
            return Ok(Metadata::CouldNotFetch);
        }

        info!(hyp_message=?message, ?validators, threshold, "List of validators and threshold for message");

        let checkpoint_syncer = match self
            .as_ref()
            .build_checkpoint_syncer(message, &validators, self.as_ref().app_context.clone())
            .await
        {
            Ok(syncer) => syncer,
            Err(CheckpointSyncerBuildError::ReorgEvent(reorg_event)) => {
                return Ok(Metadata::Refused(format!(
                    "A reorg event occurred {:?}",
                    reorg_event
                )));
            }
            Err(e) => {
                return Err(e).context(CTX);
            }
        };

        if let Some(metadata) = self
            .fetch_metadata(&validators, threshold, message, &checkpoint_syncer)
            .await
            .context(CTX)?
        {
            debug!(hyp_message=?message, ?metadata.checkpoint, "Found checkpoint with quorum");
            Ok(Metadata::Found(self.format_metadata(metadata)?))
        } else {
            info!(
                hyp_message=?message, ?validators, threshold, ism=%multisig_ism.address(),
                "Could not fetch metadata: Unable to reach quorum"
            );
            Ok(Metadata::CouldNotFetch)
        }
    }
}
