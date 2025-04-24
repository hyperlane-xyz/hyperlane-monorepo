use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;
use ethers::abi::Token;

use eyre::{Context, Result};
use hyperlane_base::cache::FunctionCallCache;
use hyperlane_base::settings::CheckpointSyncerBuildError;
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{HyperlaneMessage, ModuleType, MultisigIsm, MultisigSignedCheckpoint, H256};
use strum::Display;
use tracing::{debug, info, warn};

use crate::msg::metadata::base::MetadataBuildError;
use crate::msg::metadata::message_builder::MessageMetadataBuilder;
use crate::msg::metadata::{IsmCachePolicy, MessageMetadataBuildParams, Metadata, MetadataBuilder};

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

const MAX_VALIDATOR_SET_SIZE: usize = 50;

#[async_trait]
pub trait MultisigIsmMetadataBuilder: AsRef<MessageMetadataBuilder> + Send + Sync {
    fn module_type(&self) -> ModuleType;

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
    ) -> Result<(Vec<H256>, u8), MetadataBuildError> {
        let ism_domain = multisig_ism.domain().name();
        let fn_key = "validators_and_threshold";

        // Depending on the cache policy, make use of the message ID
        let params_cache_key = match self
            .as_ref()
            .base_builder()
            .ism_cache_policy_classifier()
            .get_cache_policy(
                self.as_ref().root_ism,
                multisig_ism.domain(),
                self.module_type(),
                self.as_ref().app_context.as_ref(),
            )
            .await
        {
            // To have the cache key be more succinct, we use the message id
            IsmCachePolicy::MessageSpecific => (multisig_ism.address(), message.id()),
            IsmCachePolicy::IsmSpecific => (multisig_ism.address(), H256::zero()),
        };

        let cache_result = self
            .as_ref()
            .base_builder()
            .cache()
            .get_cached_call_result::<(Vec<H256>, u8)>(ism_domain, fn_key, &params_cache_key)
            .await
            .map_err(|err| {
                warn!(error = %err, "Error when caching call result for {:?}", fn_key);
            })
            .ok()
            .flatten();

        match cache_result {
            Some(result) => Ok(result),
            None => {
                let result = multisig_ism
                    .validators_and_threshold(message)
                    .await
                    .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

                self.as_ref()
                    .base_builder()
                    .cache()
                    .cache_call_result(ism_domain, fn_key, &params_cache_key, &result)
                    .await
                    .map_err(|err| {
                        warn!(error = %err, "Error when caching call result for {:?}", fn_key);
                    })
                    .ok();
                Ok(result)
            }
        }
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

        let (validators, threshold) = self
            .call_validators_and_threshold(&multisig_ism, message)
            .await?;

        if validators.is_empty() {
            info!("Could not fetch metadata: No validator set found for ISM");
            return Err(MetadataBuildError::CouldNotFetch);
        }

        // Dismiss large validator sets
        if validators.len() > MAX_VALIDATOR_SET_SIZE {
            info!(
                ?ism_address,
                validator_count = validators.len(),
                max_validator_count = MAX_VALIDATOR_SET_SIZE,
                "Skipping metadata: Too many validators in ISM"
            );
            return Err(MetadataBuildError::MaxValidatorCountReached(
                validators.len() as u32,
            ));
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
