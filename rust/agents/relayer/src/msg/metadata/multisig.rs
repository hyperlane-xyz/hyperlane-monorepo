use std::collections::HashMap;
use std::fmt::Debug;
use std::ops::Deref;

use async_trait::async_trait;
use derive_new::new;
use ethers::abi::Token;
use eyre::Context;
use tracing::{debug, info, instrument};

use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{
    HyperlaneMessage, MultisigIsm, MultisigSignedCheckpoint, SignatureWithSigner, H256,
};

use super::base::MetadataBuilder;
use super::BaseMetadataBuilder;

#[derive(Clone, Debug, new)]
pub struct MultisigIsmMetadataBuilder {
    base: BaseMetadataBuilder,
    legacy: bool,
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
        let multisig_ism = self.build_multisig_ism(ism_address).await.context(CTX)?;

        let (validators, threshold) = multisig_ism
            .validators_and_threshold(message)
            .await
            .context(CTX)?;
        let Some(checkpoint) = self.fetch_checkpoint(&validators, threshold.into(), message)
            .await.context(CTX)?
        else {
            if validators.is_empty() {
                info!(
                    ism=%multisig_ism.address(),
                    chain=%self.base.domain().name(),
                    "Could not fetch metadata: No validator set for chain is configured on the recipient's ISM"
                );
            } else {
                info!(
                    ?validators, threshold, ism=%multisig_ism.address(),
                    "Could not fetch metadata: Unable to reach quorum"
                );
            }
            return Ok(None);
        };

        // At this point we have a signed checkpoint with a quorum of validator
        // signatures. But it may be a fraudulent checkpoint that doesn't
        // match the canonical root at the checkpoint's index.
        debug!(?checkpoint, "Found checkpoint with quorum");

        let proof = self
            .get_proof(message, checkpoint.clone())
            .await
            .context(CTX)?;

        if checkpoint.checkpoint.root == proof.root() {
            debug!(
                ?validators,
                threshold,
                ?checkpoint,
                ?proof,
                "Fetched metadata"
            );
            let metadata = self.format_metadata(&validators, threshold, &checkpoint, &proof);
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
        // TODO: remove - this is a temporary workaround to get Sealevel deliveries
        // working. There's a max tx size that the metadata will hit, and for testing
        // we're just using a noop ISM.
        if checkpoint.checkpoint.mailbox_domain == 13375 {
            return vec![];
        }

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

        if self.legacy {
            let validator_tokens: Vec<Token> = validators
                .iter()
                .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
                .collect();
            let validator_bytes = ethers::abi::encode(&[Token::FixedArray(validator_tokens)]);
            [
                root_bytes,
                index_bytes,
                mailbox_and_proof_bytes,
                Vec::from([threshold]),
                signature_bytes,
                validator_bytes,
            ]
            .concat()
        } else {
            [
                root_bytes,
                index_bytes,
                mailbox_and_proof_bytes,
                signature_bytes,
            ]
            .concat()
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
