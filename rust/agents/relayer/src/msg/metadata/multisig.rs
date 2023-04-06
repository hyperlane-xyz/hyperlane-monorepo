use async_trait::async_trait;
use ethers::abi::Token;
use hyperlane_core::accumulator::merkle::Proof;
use std::collections::HashMap;
use std::fmt::Debug;
use std::{ops::Deref};

use derive_new::new;
use eyre::Context;
use tracing::{debug, info, instrument};

use hyperlane_core::{HyperlaneMessage, MultisigIsm, H256, MultisigSignedCheckpoint, SignatureWithSigner};

use super::BaseMetadataBuilder;
use super::base::{MetadataBuilder, SupportedIsmTypes};

#[derive(Clone, Debug, new)]
pub struct MultisigIsmMetadataBuilder {
    module_type: SupportedIsmTypes,
    base: BaseMetadataBuilder,
}

impl Deref for MultisigIsmMetadataBuilder {
    type Target = BaseMetadataBuilder;

    fn deref(&self) -> &Self::Target {
        &self.base
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
        let multisig_ism = self
            .base
            .chain_setup
            .build_multisig_ism(ism_address, &self.metrics)
            .await
            .context(CTX)?;

        let (validators, threshold) = multisig_ism
            .validators_and_threshold(message)
            .await
            .context(CTX)?;
        let highest_known_nonce = self.prover_sync.read().await.count() - 1;
        let checkpoint_syncer = self
            .build_checkpoint_syncer(&validators)
            .await
            .context(CTX)?;
        let Some(checkpoint) = checkpoint_syncer
            .fetch_checkpoint_in_range(
                &validators,
                threshold.into(),
                message.nonce,
                highest_known_nonce,
            )
            .await.context(CTX)?
        else {
            info!(
                ?validators, threshold, highest_known_nonce,
                "Could not fetch metadata: Unable to reach quorum"
            );
            return Ok(None);
        };

        // At this point we have a signed checkpoint with a quorum of validator
        // signatures. But it may be a fraudulent checkpoint that doesn't
        // match the canonical root at the checkpoint's index.
        debug!(?checkpoint, "Found checkpoint with quorum");

        let proof = self
            .prover_sync
            .read()
            .await
            .get_proof(message.nonce, checkpoint.checkpoint.index)
            .context(CTX)?;

        if checkpoint.checkpoint.root == proof.root() {
            debug!(
                ?validators,
                threshold,
                ?checkpoint,
                ?proof,
                "Fetched metadata"
            );
            let metadata =
                self.format_metadata(&validators, threshold, &checkpoint, &proof);
            Ok(Some(metadata))
        } else {
            info!(
                ?checkpoint,
                canonical_root = ?proof.root(),
                "Could not fetch metadata: Signed checkpoint does not match canonical root"
            );
            Ok(None)
        }
    }
}

impl MultisigIsmMetadataBuilder {
    /// Returns the metadata needed by the contract's verify function
    fn format_metadata(
        &self,
        validators: &[H256],
        threshold: u8,
        checkpoint: &MultisigSignedCheckpoint,
        proof: &Proof,
    ) -> Vec<u8> {
        assert_eq!(threshold as usize, checkpoint.signatures.len());
        let root_bytes = checkpoint.checkpoint.root.to_fixed_bytes().into();
        let index_bytes = checkpoint.checkpoint.index.to_be_bytes().into();
        let proof_tokens: Vec<Token> = proof
            .path
            .iter()
            .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
            .collect();
        let mailbox_and_proof_bytes = ethers::abi::encode(&[
            Token::FixedBytes(
                checkpoint
                    .checkpoint
                    .mailbox_address
                    .to_fixed_bytes()
                    .into(),
            ),
            Token::FixedArray(proof_tokens),
        ]);

        // The ethers encoder likes to zero-pad non word-aligned byte arrays.
        // Thus, we pack the signatures, which are not word-aligned, ourselves.
        let signature_vecs: Vec<Vec<u8>> = order_signatures(validators, &checkpoint.signatures);
        let signature_bytes = signature_vecs.concat();

        let validator_tokens: Vec<Token> = validators
            .iter()
            .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
            .collect();
        let validator_bytes = ethers::abi::encode(&[Token::FixedArray(validator_tokens)]);
        let metadata = match self.module_type {
            SupportedIsmTypes::Multisig => {
        [
            root_bytes,
            index_bytes,
            mailbox_and_proof_bytes,
            signature_bytes,
        ]
        .concat()
            }
            SupportedIsmTypes::LegacyMultisig => {
        [
            root_bytes,
            index_bytes,
            mailbox_and_proof_bytes,
            Vec::from([threshold]),
            signature_bytes,
            validator_bytes,
        ]
        .concat()
            }
        };
        metadata
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
