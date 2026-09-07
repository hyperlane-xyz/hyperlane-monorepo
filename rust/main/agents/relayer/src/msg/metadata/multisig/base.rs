use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::Result;
use hyperlane_base::cache::FunctionCallCache;
use hyperlane_base::settings::CheckpointSyncerBuildError;
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::accumulator::{merkle::Proof, TREE_DEPTH};
use hyperlane_core::{
    HyperlaneMessage, Metadata, ModuleType, MultisigIsm, MultisigSignedCheckpoint, H256,
};
use strum::Display;
use tracing::{debug, info, warn};

use crate::msg::metadata::base::{MetadataBuildError, MetadataBuildRefused};
use crate::msg::metadata::base_builder::IsmBuildMetricsParams;
use crate::msg::metadata::message_builder::MessageMetadataBuilder;
use crate::msg::metadata::{IsmCachePolicy, MessageMetadataBuildParams, MetadataBuilder};

#[derive(new, AsRef, Deref, Debug, PartialEq)]
pub struct MultisigMetadata {
    #[deref]
    quorum_checkpoint: MultisigSignedCheckpoint,
    merkle_leaf_index: u32,
    // optional because it's only used for MerkleRootMultisig
    proof: Option<Proof>,
}

impl MultisigMetadata {
    fn format(&self, layout: &[MetadataToken]) -> Vec<u8> {
        const SIGNATURE_LENGTH: usize = 65;
        let size = layout.iter().fold(0usize, |size, token| {
            size.saturating_add(match token {
                MetadataToken::CheckpointMerkleRoot
                | MetadataToken::CheckpointMerkleTreeHook
                | MetadataToken::MessageId => H256::len_bytes(),
                MetadataToken::MessageMerkleLeafIndex | MetadataToken::CheckpointIndex => {
                    std::mem::size_of::<u32>()
                }
                MetadataToken::MerkleProof => TREE_DEPTH.saturating_mul(H256::len_bytes()),
                MetadataToken::Signatures => self.signatures.len().saturating_mul(SIGNATURE_LENGTH),
            })
        });
        let mut output = Vec::with_capacity(size);
        for token in layout {
            match token {
                MetadataToken::CheckpointMerkleRoot => {
                    output.extend_from_slice(self.checkpoint.root.as_bytes());
                }
                MetadataToken::MessageMerkleLeafIndex => {
                    output.extend_from_slice(&self.merkle_leaf_index.to_be_bytes());
                }
                MetadataToken::CheckpointIndex => {
                    output.extend_from_slice(&self.checkpoint.index.to_be_bytes());
                }
                MetadataToken::CheckpointMerkleTreeHook => {
                    output.extend_from_slice(self.checkpoint.merkle_tree_hook_address.as_bytes());
                }
                MetadataToken::MessageId => {
                    output.extend_from_slice(self.checkpoint.message_id.as_bytes());
                }
                MetadataToken::MerkleProof => {
                    // ABI bytes32 values are already one word each: no offset, length or padding.
                    for sibling in &self.proof.as_ref().expect("Metadata is missing proof").path {
                        output.extend_from_slice(sibling.as_bytes());
                    }
                }
                MetadataToken::Signatures => {
                    for signature in &self.signatures {
                        output.extend_from_slice(&<[u8; SIGNATURE_LENGTH]>::from(signature));
                    }
                }
            }
        }
        output
    }
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
    ) -> Result<Option<MultisigMetadata>, MetadataBuildError>;

    fn token_layout(&self) -> &'static [MetadataToken];

    fn format_metadata(&self, metadata: MultisigMetadata) -> Result<Vec<u8>> {
        Ok(metadata.format(self.token_layout()))
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
        params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        let res = metadata_build(self, ism_address, message, params).await;

        // update metrics
        let ism_build_metrics_params = IsmBuildMetricsParams {
            app_context: self.as_ref().app_context.clone(),
            success: res.is_ok(),
            origin: self.as_ref().base_builder().origin_domain().clone(),
            destination: self.as_ref().base_builder().destination_domain().clone(),
            ism_type: self.module_type(),
        };
        self.as_ref()
            .base_builder()
            .update_ism_metric(ism_build_metrics_params);
        res
    }
}

async fn metadata_build<T: MultisigIsmMetadataBuilder>(
    ism_builder: &T,
    ism_address: H256,
    message: &HyperlaneMessage,
    _params: MessageMetadataBuildParams,
) -> Result<Metadata, MetadataBuildError> {
    let multisig_ism = ism_builder
        .as_ref()
        .base_builder()
        .build_multisig_ism(ism_address)
        .await
        .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

    let (validators, threshold) = ism_builder
        .call_validators_and_threshold(&multisig_ism, message)
        .await?;

    build_with_known_validators(ism_builder, ism_address, validators, threshold, message).await
}

async fn build_with_known_validators<T: MultisigIsmMetadataBuilder>(
    ism_builder: &T,
    ism_address: H256,
    validators: Vec<H256>,
    threshold: u8,
    message: &HyperlaneMessage,
) -> Result<Metadata, MetadataBuildError> {
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

    let checkpoint_syncer = match ism_builder
        .as_ref()
        .base_builder()
        .build_checkpoint_syncer(
            message,
            &validators,
            ism_builder.as_ref().app_context.clone(),
        )
        .await
    {
        Ok(syncer) => syncer,
        Err(CheckpointSyncerBuildError::ReorgFlag(reorg_resp)) => {
            return Err(MetadataBuildError::Refused(MetadataBuildRefused::Reorg(
                reorg_resp,
            )));
        }
        Err(e) => {
            return Err(MetadataBuildError::FailedToBuild(e.to_string()));
        }
    };

    let metadata = ism_builder
        .fetch_metadata(&validators, threshold, message, &checkpoint_syncer)
        .await
        .map_err(|_| MetadataBuildError::CouldNotFetch)?
        .ok_or_else(|| {
            info!(
                hyp_message=?message, ?validators, threshold, %ism_address,
                "Could not fetch metadata: Unable to reach quorum"
            );
            MetadataBuildError::AwaitingValidatorSignatures
        })?;

    debug!(hyp_message=?message, ?metadata.checkpoint, "Found checkpoint with quorum");
    let formatted = ism_builder
        .format_metadata(metadata)
        .map_err(|_| MetadataBuildError::CouldNotFetch)?;
    Ok(Metadata::new(formatted))
}

/// Builds metadata from a pre-resolved validator set, bypassing ISM contract lookup.
///
/// Applies all the same guards as the normal path (empty-set, size cap, reorg) and
/// updates ISM build metrics.  Use this when the caller already holds validators and
/// threshold (e.g. Sealevel composite ISM).
pub(crate) async fn build_from_known_validators<T: MultisigIsmMetadataBuilder>(
    ism_builder: &T,
    message: &HyperlaneMessage,
    validators: Vec<H256>,
    threshold: u8,
) -> Result<Metadata, MetadataBuildError> {
    let res =
        build_with_known_validators(ism_builder, H256::zero(), validators, threshold, message)
            .await;
    let ism_build_metrics_params = IsmBuildMetricsParams {
        app_context: ism_builder.as_ref().app_context.clone(),
        success: res.is_ok(),
        origin: ism_builder.as_ref().base_builder().origin_domain().clone(),
        destination: ism_builder
            .as_ref()
            .base_builder()
            .destination_domain()
            .clone(),
        ism_type: ism_builder.module_type(),
    };
    ism_builder
        .as_ref()
        .base_builder()
        .update_ism_metric(ism_build_metrics_params);
    res
}

#[cfg(test)]
mod tests {
    use ethers::abi::{encode, Token};
    use hyperlane_core::{Checkpoint, CheckpointWithMessageId, Signature, U256};

    use super::*;

    // Retain the prior ABI-based encoder as an independent byte-layout oracle.
    fn legacy_format(metadata: &MultisigMetadata, layout: &[MetadataToken]) -> Vec<u8> {
        let fields: Vec<Vec<u8>> = layout
            .iter()
            .map(|token| match token {
                MetadataToken::CheckpointMerkleRoot => metadata.checkpoint.root.as_bytes().to_vec(),
                MetadataToken::CheckpointIndex => metadata.checkpoint.index.to_be_bytes().to_vec(),
                MetadataToken::CheckpointMerkleTreeHook => metadata
                    .checkpoint
                    .merkle_tree_hook_address
                    .as_bytes()
                    .to_vec(),
                MetadataToken::MessageId => metadata.checkpoint.message_id.as_bytes().to_vec(),
                MetadataToken::MerkleProof => encode(
                    &metadata
                        .proof
                        .expect("Merkle proof fixture")
                        .path
                        .iter()
                        .map(|hash| Token::FixedBytes(hash.as_bytes().to_vec()))
                        .collect::<Vec<_>>(),
                ),
                MetadataToken::MessageMerkleLeafIndex => {
                    metadata.merkle_leaf_index.to_be_bytes().to_vec()
                }
                MetadataToken::Signatures => metadata
                    .signatures
                    .iter()
                    .map(|signature| signature.to_vec())
                    .collect::<Vec<_>>()
                    .concat(),
            })
            .collect();
        fields.into_iter().flatten().collect()
    }

    #[test]
    fn packed_multisig_metadata_matches_legacy_abi_encoder() {
        let message_id_layout = [
            MetadataToken::CheckpointMerkleTreeHook,
            MetadataToken::CheckpointMerkleRoot,
            MetadataToken::CheckpointIndex,
            MetadataToken::Signatures,
        ];
        let merkle_root_layout = [
            MetadataToken::CheckpointMerkleTreeHook,
            MetadataToken::MessageMerkleLeafIndex,
            MetadataToken::MessageId,
            MetadataToken::MerkleProof,
            MetadataToken::CheckpointIndex,
            MetadataToken::Signatures,
        ];
        for count in [0_u32, 1, 3, 50] {
            for index in [0, 1, u32::MAX] {
                for v in [0, 1, 27, 28, 255, 256, u64::MAX] {
                    let mut metadata = MultisigMetadata::new(
                        MultisigSignedCheckpoint {
                            checkpoint: CheckpointWithMessageId {
                                checkpoint: Checkpoint {
                                    merkle_tree_hook_address: H256::repeat_byte(0x12),
                                    mailbox_domain: 7,
                                    root: H256::repeat_byte(0x34),
                                    index,
                                },
                                message_id: H256::repeat_byte(0x56),
                            },
                            signatures: (0..count)
                                .map(|i| Signature {
                                    r: U256::from(i),
                                    s: U256::max_value().saturating_sub(U256::from(i)),
                                    v,
                                })
                                .collect(),
                        },
                        index.saturating_sub(1),
                        None,
                    );
                    assert_eq!(
                        metadata.format(&message_id_layout),
                        legacy_format(&metadata, &message_id_layout)
                    );
                    metadata.proof = Some(Proof {
                        leaf: H256::repeat_byte(0x78),
                        index: 9,
                        path: std::array::from_fn(|i| {
                            H256::repeat_byte(u8::try_from(i).expect("proof depth fits u8"))
                        }),
                    });
                    assert_eq!(
                        metadata.format(&merkle_root_layout),
                        legacy_format(&metadata, &merkle_root_layout)
                    );
                }
            }
        }
    }
}
