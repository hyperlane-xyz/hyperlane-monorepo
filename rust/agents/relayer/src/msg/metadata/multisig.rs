use std::collections::HashMap;
use std::fmt::Debug;
use std::ops::Deref;
use std::todo;

use async_trait::async_trait;
use derive_new::new;
use ethers::abi::Token;

use eyre::Context;
use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{Checkpoint, HyperlaneMessage, ModuleType, SignatureWithSigner, H256};
use tracing::{debug, info, instrument};

use super::{BaseMetadataBuilder, MetadataBuilder};

#[derive(Clone, Debug, new)]
pub struct MultisigIsmMetadataBuilder {
    base: BaseMetadataBuilder,
    variant: ModuleType,
}

impl Deref for MultisigIsmMetadataBuilder {
    type Target = BaseMetadataBuilder;

    fn deref(&self) -> &Self::Target {
        &self.base
    }
}

enum MetadataToken {
    CheckpointRoot,
    CheckpointIndex,
    CheckpointMailbox,
    MessageId,
    MerkleProof,
    Threshold,
    Signatures,
    Validators,
}

impl MultisigIsmMetadataBuilder {
    fn build_token(
        &self,
        token: &MetadataToken,
        message: &HyperlaneMessage,
        checkpoint: &Checkpoint,
        proof: &Proof,
        validators: &[H256],
        signatures: &[SignatureWithSigner],
        threshold: u8,
    ) -> Vec<u8> {
        match token {
            MetadataToken::CheckpointRoot => checkpoint.root.to_fixed_bytes().into(),
            MetadataToken::CheckpointIndex => checkpoint.index.to_be_bytes().into(),
            MetadataToken::CheckpointMailbox => checkpoint.mailbox_address.to_fixed_bytes().into(),
            MetadataToken::MessageId => message.id().to_fixed_bytes().into(),
            MetadataToken::Threshold => Vec::from([threshold]),
            MetadataToken::MerkleProof => {
                let proof_tokens: Vec<Token> = proof
                    .path
                    .iter()
                    .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
                    .collect();
                return ethers::abi::encode(&proof_tokens);
            }
            MetadataToken::Validators => {
                let validator_tokens: Vec<Token> = validators
                    .iter()
                    .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
                    .collect();
                return ethers::abi::encode(&[Token::FixedArray(validator_tokens)]);
            }
            MetadataToken::Signatures => order_signatures(validators, signatures).concat(),
        }
    }

    fn token_layout(&self) -> Vec<MetadataToken> {
        match self.variant {
            ModuleType::LegacyMultisig => vec![
                MetadataToken::CheckpointRoot,
                MetadataToken::CheckpointIndex,
                MetadataToken::CheckpointMailbox,
                MetadataToken::MerkleProof,
                MetadataToken::Threshold,
                MetadataToken::Signatures,
                MetadataToken::Validators,
            ],
            ModuleType::MerkleRootMultisig => vec![
                MetadataToken::CheckpointMailbox,
                MetadataToken::CheckpointIndex,
                MetadataToken::MessageId,
                MetadataToken::MerkleProof,
                MetadataToken::Signatures,
            ],
            ModuleType::MessageIdMultisig => vec![
                MetadataToken::CheckpointMailbox,
                MetadataToken::CheckpointRoot,
                MetadataToken::Signatures,
            ],
            _ => todo!(),
        }
    }
}

#[async_trait]
impl MetadataBuilder for MultisigIsmMetadataBuilder {
    #[instrument(err)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching MultisigIsm metadata";
        let multisig_ism = self.build_multisig_ism(ism_address).await.context(CTX)?;

        let (validators, threshold) = multisig_ism
            .validators_and_threshold(message)
            .await
            .context(CTX)?;
        if validators.is_empty() {
            info!(
                ism=%multisig_ism.address(),
                chain=%self.base.domain().name(),
                "Could not fetch metadata: No validator set for chain is configured on the recipient's ISM"
            );
        }

        let checkpoint: Checkpoint;
        let signatures: Vec<SignatureWithSigner>;
        match self.variant {
            ModuleType::LegacyMultisig => {
                let Some(quorum_checkpoint) = self.fetch_checkpoint(&validators, threshold.into(), message)
                    .await.context(CTX)?
                else {
                    info!(
                        ?validators, threshold, ism=%multisig_ism.address(),
                        "Could not fetch metadata: Unable to reach quorum"
                    );
                    return Ok(None);
                };
                checkpoint = quorum_checkpoint.checkpoint;
                signatures = quorum_checkpoint.signatures;
            },
            ModuleType::MerkleRootMultisig | ModuleType::MessageIdMultisig => {
                let Some(quorum_checkpoint) = self.fetch_checkpoint_with_message_id(&validators, threshold.into(), message)
                    .await.context(CTX)?
                else {
                    info!(
                        ?validators, threshold, ism=%multisig_ism.address(),
                        "Could not fetch metadata: Unable to reach quorum"
                    );
                    return Ok(None);
                };
                checkpoint = quorum_checkpoint.checkpoint.checkpoint;
                signatures = quorum_checkpoint.signatures;
            },
            _ => todo!()
        }

        // At this point we have a signed checkpoint with a quorum of validator
        // signatures. But it may be a fraudulent checkpoint that doesn't
        // match the canonical root at the checkpoint's index.
        debug!(?checkpoint, "Found checkpoint with quorum");

        let proof = self
            .get_proof(message, checkpoint)
            .await
            .context(CTX)?;

        if checkpoint.root != proof.root() {
            info!(
                ?checkpoint,
                canonical_root = ?proof.root(),
                "Could not fetch metadata: Signed checkpoint does not match canonical root"
            );
            return Ok(None);
        }

        debug!(
            ?validators,
            threshold,
            ?checkpoint,
            ?proof,
            "Fetched metadata"
        );

        let token_bytes: Vec<Vec<u8>> = self.token_layout()
            .iter()
            .map(|token| {
                self.build_token(
                    token,
                    &message,
                    &checkpoint,
                    &proof,
                    &validators,
                    &signatures,
                    threshold,
                )
            }).collect();

        return Ok(Some(token_bytes.concat()));
    }
}

/// Orders `signatures` by the signers according to the `desired_order`.
/// Returns a Vec of the signature raw bytes in the correct order.
/// Panics if any signers in `signatures` are not present in `desired_order`
fn order_signatures(desired_order: &[H256], signatures: &[SignatureWithSigner]) -> Vec<Vec<u8>> {
    // Signer address => index to sort by
    let ordering_map: HashMap<H256, usize> = desired_order
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, a)| (a, index))
        .collect();

    // Create a tuple of (SignatureWithSigner, index to sort by)
    let mut ordered_signatures = signatures
        .iter()
        .cloned()
        .map(|s| {
            let order_index = ordering_map.get(&H256::from(s.signer)).unwrap();
            (s, *order_index)
        })
        .collect::<Vec<(SignatureWithSigner, usize)>>();
    // Sort by the index
    ordered_signatures.sort_by_key(|s| s.1);
    // Now collect only the raw signature bytes
    ordered_signatures
        .iter()
        .map(|s| s.0.signature.to_vec())
        .collect()
}
