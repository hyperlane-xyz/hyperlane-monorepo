use std::collections::HashMap;
use std::fmt::Debug;

use async_trait::async_trait;
use derive_new::new;
use ethers::abi::Token;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{Checkpoint, HyperlaneMessage, SignatureWithSigner, H256};
use strum::Display;
use tracing::{debug, info};

use crate::msg::metadata::BaseMetadataBuilder;
use crate::msg::metadata::MetadataBuilder;

#[derive(new)]
pub struct MultisigMetadata {
    checkpoint: Checkpoint,
    signatures: Vec<SignatureWithSigner>,
    message_id: Option<H256>,
    proof: Option<Proof>,
}

#[derive(Debug, Display, PartialEq, Eq, Clone)]
pub enum MetadataToken {
    CheckpointRoot,
    CheckpointIndex,
    CheckpointMailbox,
    MessageId,
    MerkleProof,
    Threshold,
    Signatures,
    Validators,
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

    fn format_metadata(
        &self,
        validators: &[H256],
        threshold: u8,
        metadata: MultisigMetadata,
    ) -> Vec<u8> {
        let build_token = |token: &MetadataToken| match token {
            MetadataToken::CheckpointRoot => metadata.checkpoint.root.to_fixed_bytes().into(),
            MetadataToken::CheckpointIndex => metadata.checkpoint.index.to_be_bytes().into(),
            MetadataToken::CheckpointMailbox => {
                metadata.checkpoint.mailbox_address.to_fixed_bytes().into()
            }
            MetadataToken::MessageId => metadata.message_id.unwrap().to_fixed_bytes().into(),
            MetadataToken::Threshold => Vec::from([threshold]),
            MetadataToken::MerkleProof => {
                let proof_tokens: Vec<Token> = metadata
                    .proof
                    .unwrap()
                    .path
                    .iter()
                    .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
                    .collect();
                ethers::abi::encode(&proof_tokens)
            }
            MetadataToken::Validators => {
                let validator_tokens: Vec<Token> = validators
                    .iter()
                    .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
                    .collect();
                ethers::abi::encode(&[Token::FixedArray(validator_tokens)])
            }
            MetadataToken::Signatures => {
                let ordered_signatures = order_signatures(validators, &metadata.signatures);
                let threshold_signatures = &ordered_signatures[..threshold as usize];
                threshold_signatures.concat()
            }
        };

        self.token_layout().iter().flat_map(build_token).collect()
    }
}

#[async_trait]
impl<T: MultisigIsmMetadataBuilder> MetadataBuilder for T {
    #[allow(clippy::async_yields_async)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
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

        let checkpoint_syncer = self
            .as_ref()
            .build_checkpoint_syncer(&validators)
            .await
            .context(CTX)?;

        if let Some(metadata) = self
            .fetch_metadata(&validators, threshold, message, &checkpoint_syncer)
            .await
            .context(CTX)?
        {
            debug!(?message, ?metadata.checkpoint, "Found checkpoint with quorum");
            Ok(Some(self.format_metadata(&validators, threshold, metadata)))
        } else {
            info!(
                ?message, ?validators, threshold, ism=%multisig_ism.address(),
                "Could not fetch metadata: Unable to reach quorum"
            );
            Ok(None)
        }
    }
}

/// Orders `signatures` by the signers according to the `desired_order`.
/// Returns a Vec of the signature raw bytes in the correct order.
/// Panics if any signers in `signatures` are not present in `desired_order`
fn order_signatures(desired_order: &[H256], signatures: &[SignatureWithSigner]) -> Vec<Vec<u8>> {
    // Signer address => index to sort by
    let ordering_map: HashMap<H256, usize> = desired_order
        .iter()
        .enumerate()
        .map(|(index, a)| (*a, index))
        .collect();

    // Create a tuple of (SignatureWithSigner, index to sort by)
    let mut ordered_signatures = signatures
        .iter()
        .cloned()
        .map(|s| {
            let order_index = ordering_map.get(&H256::from(s.signer)).unwrap();
            (s, *order_index)
        })
        .collect::<Vec<_>>();
    // Sort by the index
    ordered_signatures.sort_by_key(|s| s.1);
    // Now collect only the raw signature bytes
    ordered_signatures
        .into_iter()
        .map(|s| s.0.signature.to_vec())
        .collect()
}
