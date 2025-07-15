use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, ModuleType, H256};
use tracing::debug;

use crate::msg::metadata::MessageMetadataBuilder;

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct MerkleRootMultisigMetadataBuilder(MessageMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for MerkleRootMultisigMetadataBuilder {
    fn module_type(&self) -> ModuleType {
        ModuleType::MerkleRootMultisig
    }

    fn token_layout(&self) -> Vec<MetadataToken> {
        vec![
            MetadataToken::CheckpointMerkleTreeHook,
            MetadataToken::MessageMerkleLeafIndex,
            MetadataToken::MessageId,
            MetadataToken::MerkleProof,
            MetadataToken::CheckpointIndex,
            MetadataToken::Signatures,
        ]
    }

    async fn fetch_metadata(
        &self,
        validators: &[H256],
        threshold: u8,
        message: &HyperlaneMessage,
        checkpoint_syncer: &MultisigCheckpointSyncer,
    ) -> Result<Option<MultisigMetadata>> {
        const CTX: &str = "When fetching MerkleRootMultisig metadata";
        let highest_leaf_index = unwrap_or_none_result!(
            self.base_builder().highest_known_leaf_index().await,
            debug!("Couldn't get highest known leaf index")
        );
        let leaf_index = unwrap_or_none_result!(
            self.base_builder()
                .get_merkle_leaf_id_by_message_id(message.id())
                .await
                .context(CTX)?,
            debug!(
                hyp_message=?message,
                "No merkle leaf found for message id, must have not been enqueued in the tree"
            )
        );
        let quorum_checkpoint = unwrap_or_none_result!(
            checkpoint_syncer
                .fetch_checkpoint_in_range(
                    validators,
                    threshold as usize,
                    leaf_index,
                    highest_leaf_index,
                    self.base_builder().origin_domain(),
                    self.base_builder().destination_domain(),
                )
                .await
                .context(CTX)?,
            debug!(
                leaf_index,
                highest_leaf_index, "Couldn't get checkpoint in range"
            )
        );
        let proof = self
            .base_builder()
            .get_proof(leaf_index, quorum_checkpoint.checkpoint.checkpoint)
            .await
            .context(CTX)?;
        Ok(Some(MultisigMetadata::new(
            quorum_checkpoint,
            leaf_index,
            Some(proof),
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use hyperlane_base::tests::dummy_validators;
    use hyperlane_base::tests::mock_checkpoint_syncer::{
        build_mock_checkpoint_syncs, generate_multisig_signed_checkpoint,
    };
    use hyperlane_base::{CheckpointSyncer, MultisigCheckpointSyncer};
    use hyperlane_core::accumulator::merkle::Proof;
    use hyperlane_core::accumulator::TREE_DEPTH;
    use hyperlane_core::{
        Checkpoint, CheckpointWithMessageId, HyperlaneDomain, HyperlaneMessage,
        KnownHyperlaneDomain, H160, H256,
    };

    use crate::msg::metadata::multisig::{MultisigIsmMetadataBuilder, MultisigMetadata};
    use crate::msg::metadata::{
        multisig::MerkleRootMultisigMetadataBuilder, MessageMetadataBuilder,
    };
    use crate::test_utils::mock_base_builder::build_mock_base_builder;

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_fetch_metadata() {
        let checkpoint = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                mailbox_domain: 100,
                merkle_tree_hook_address: H256::zero(),
                root: H256::zero(),
                index: 1000,
            },
            message_id: H256::zero(),
        };

        let mut validators: Vec<_> = dummy_validators().drain(..).take(5).collect();
        validators[0].latest_index = Some(1010);
        validators[0].fetch_checkpoint = Some(checkpoint.clone());
        validators[1].latest_index = Some(1008);
        validators[2].latest_index = Some(1006);
        validators[3].latest_index = Some(1004);
        validators[3].fetch_checkpoint = Some(checkpoint.clone());
        validators[4].latest_index = Some(1002);
        validators[4].fetch_checkpoint = Some(checkpoint.clone());

        let syncers = build_mock_checkpoint_syncs(&validators).await;
        let validator_addresses = validators
            .iter()
            .map(|validator| validator.public_key.parse::<H160>().unwrap().into())
            .collect::<Vec<_>>();

        let signed_checkpoint = generate_multisig_signed_checkpoint(&validators, checkpoint).await;

        let syncers: HashMap<_, _> = syncers
            .into_iter()
            .map(|(k, v)| (k, Arc::new(v) as Arc<dyn CheckpointSyncer>))
            .collect();
        // Create a multisig checkpoint syncer
        let multisig_syncer = MultisigCheckpointSyncer::new(syncers, None);

        let base_builder = build_mock_base_builder(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        );
        base_builder
            .responses
            .get_merkle_leaf_id_by_message_id
            .lock()
            .unwrap()
            .push_back(Ok(Some(100)));
        base_builder
            .responses
            .highest_known_leaf_index
            .lock()
            .unwrap()
            .push_back(Some(1000));

        let proof = Proof {
            leaf: H256::zero(),
            index: 100,
            path: [H256::zero(); TREE_DEPTH],
        };
        base_builder
            .responses
            .get_proof
            .lock()
            .unwrap()
            .push_back(Ok(proof.clone()));

        let ism_address = H256::zero();
        let message = HyperlaneMessage::default();
        let message_builder = {
            let builder =
                MessageMetadataBuilder::new(Arc::new(base_builder), ism_address, &message)
                    .await
                    .expect("Failed to build MessageMetadataBuilder");
            builder
        };
        let builder = MerkleRootMultisigMetadataBuilder::new(message_builder);

        let threshold = 3;
        let resp = builder
            .fetch_metadata(&validator_addresses, threshold, &message, &multisig_syncer)
            .await
            .expect("Failed to fetch metadata")
            .expect("Expected MultisigMetadata");

        let expected = MultisigMetadata::new(signed_checkpoint, 100, Some(proof));
        assert_eq!(resp.checkpoint, expected.checkpoint);
        assert_eq!(resp.signatures, expected.signatures);
    }
}
