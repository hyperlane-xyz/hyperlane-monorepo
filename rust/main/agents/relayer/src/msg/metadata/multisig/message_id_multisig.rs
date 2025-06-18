use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, ModuleType, H256};
use tracing::{debug, warn};

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};
use crate::msg::metadata::MessageMetadataBuilder;

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct MessageIdMultisigMetadataBuilder(MessageMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for MessageIdMultisigMetadataBuilder {
    fn module_type(&self) -> ModuleType {
        ModuleType::MessageIdMultisig
    }

    fn token_layout(&self) -> Vec<MetadataToken> {
        vec![
            MetadataToken::CheckpointMerkleTreeHook,
            MetadataToken::CheckpointMerkleRoot,
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
        let message_id = message.id();
        const CTX: &str = "When fetching MessageIdMultisig metadata";
        let leaf_index = unwrap_or_none_result!(
            self.base_builder()
                .get_merkle_leaf_id_by_message_id(message_id)
                .await
                .context(CTX)?,
            debug!(
                hyp_message=?message,
                "No merkle leaf found for message id, must have not been enqueued in the tree"
            )
        );

        // Update the validator latest checkpoint metrics.
        let _ = checkpoint_syncer
            .get_validator_latest_checkpoints_and_update_metrics(
                validators,
                self.base_builder().origin_domain(),
                self.base_builder().destination_domain(),
            )
            .await;

        let quorum_checkpoint = unwrap_or_none_result!(
            checkpoint_syncer
                .fetch_checkpoint(validators, threshold as usize, leaf_index)
                .await
                .context(CTX)?,
            debug!("No quorum checkpoint found")
        );

        if quorum_checkpoint.checkpoint.message_id != message_id {
            warn!(
                "Quorum checkpoint message id {} does not match message id {}",
                quorum_checkpoint.checkpoint.message_id, message_id
            );
            if quorum_checkpoint.checkpoint.index != leaf_index {
                warn!(
                    "Quorum checkpoint index {} does not match leaf index {}",
                    quorum_checkpoint.checkpoint.index, leaf_index
                );
            }
            return Ok(None);
        }

        Ok(Some(MultisigMetadata::new(
            quorum_checkpoint,
            leaf_index,
            None,
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use hyperlane_base::mock_checkpoint_syncer::{
        build_mock_checkpoint_syncs, generate_multisig_signed_checkpoint,
    };
    use hyperlane_base::{CheckpointSyncer, MultisigCheckpointSyncer};
    use hyperlane_core::{
        Checkpoint, CheckpointWithMessageId, HyperlaneDomain, HyperlaneMessage,
        KnownHyperlaneDomain, H256,
    };

    use crate::msg::metadata::multisig::{
        MessageIdMultisigMetadataBuilder, MultisigIsmMetadataBuilder, MultisigMetadata,
    };
    use crate::msg::metadata::MessageMetadataBuilder;
    use crate::test_utils::mock_base_builder::build_mock_base_builder;

    const PRIVATE_KEY_1: &str = "254bf805ec98536bbcfcf7bd88f58aa17bcf2955138237d3d06288d39fabfecb";
    const PUBLIC_KEY_1: &str = "c4bED0DD629b734C96779D30e1fcFa5346863C4C";

    const PRIVATE_KEY_2: &str = "5c5ec0dd04b7a8b4ea7d204bb8d30159fe33bdf29c0015986b430ff5b952b5fb";
    const PUBLIC_KEY_2: &str = "96DE69f859ed40FB625454db3BFc4f2Da4848dcF";

    const PRIVATE_KEY_3: &str = "113c56f0b006dd07994ec518eb02a9b37ddd2187232bc8ea820b1fe7d719c6cd";
    const PUBLIC_KEY_3: &str = "c7504D7F7FC865Ba69abad3b18c639372AE687Ec";

    const PRIVATE_KEY_4: &str = "9ccd363180a8e11730d017cf945c93533070a5e755f178e171bee861407b225a";
    const PUBLIC_KEY_4: &str = "197325f955852A61a5b2DEFb7BAffB8763D1acE8";

    const PRIVATE_KEY_5: &str = "3fdfa6dd5c1e40e5c7dc84e82253cdb96c90a6d400542e21d5e69965adc44077";
    const PUBLIC_KEY_5: &str = "2C8Ac45c649C1d242706FB1fc078bc0759c02f80";

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_fetch_metadata() {
        let message = HyperlaneMessage::default();
        let checkpoint = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                mailbox_domain: 100,
                merkle_tree_hook_address: H256::zero(),
                root: H256::zero(),
                index: 1000,
            },
            message_id: message.id(),
        };

        let validators = dummy_validators(checkpoint.clone());

        let syncers = build_mock_checkpoint_syncs(&validators).await;

        let validator_addresses = validators
            .iter()
            .map(|validator| validator.public_key.clone().into())
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
            .push_back(Ok(Some(1000)));
        base_builder
            .responses
            .highest_known_leaf_index
            .lock()
            .unwrap()
            .push_back(Some(1000));

        base_builder
            .responses
            .get_proof
            .lock()
            .unwrap()
            .push_back(Err(eyre::eyre!("No Proof")));

        let ism_address = H256::zero();
        let message_builder = {
            let builder =
                MessageMetadataBuilder::new(Arc::new(base_builder), ism_address, &message)
                    .await
                    .expect("Failed to build MessageMetadataBuilder");
            builder
        };
        let builder = MessageIdMultisigMetadataBuilder::new(message_builder);

        let threshold = 3;
        let resp = builder
            .fetch_metadata(&validator_addresses, threshold, &message, &multisig_syncer)
            .await
            .expect("Failed to fetch metadata")
            .expect("Expected MultisigMetadata");

        let expected = MultisigMetadata::new(signed_checkpoint, 1000, None);
        assert_eq!(resp, expected);
    }
}
