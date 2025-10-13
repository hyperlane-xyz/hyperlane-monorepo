use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::Result;
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, ModuleType, H256};
use tracing::{debug, warn};

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};
use crate::msg::metadata::{MessageMetadataBuilder, MetadataBuildError};

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
    ) -> Result<Option<MultisigMetadata>, MetadataBuildError> {
        let message_id = message.id();
        let leaf_index = unwrap_or_none_result!(
            self.base_builder()
                .get_merkle_leaf_id_by_message_id(message_id)
                .await
                .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?,
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
                .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?,
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

    use hyperlane_base::tests::dummy_validators;
    use hyperlane_base::tests::mock_checkpoint_syncer::{
        build_mock_checkpoint_syncs, generate_multisig_signed_checkpoint,
    };
    use hyperlane_base::{CheckpointSyncer, MultisigCheckpointSyncer};
    use hyperlane_core::{
        ChainResult, Checkpoint, CheckpointWithMessageId, HyperlaneChain, HyperlaneContract,
        HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, KnownHyperlaneDomain, ModuleType,
        MultisigIsm, H160, H256,
    };

    use crate::msg::metadata::multisig::{
        MessageIdMultisigMetadataBuilder, MultisigIsmMetadataBuilder, MultisigMetadata,
    };
    use crate::msg::metadata::{
        IsmBuildMetricsParams, MessageMetadataBuildParams, MessageMetadataBuilder,
        MetadataBuildError, MetadataBuilder,
    };
    use crate::test_utils::mock_base_builder::build_mock_base_builder;

    mockall::mock! {
        #[derive(Clone, Debug)]
        pub MockMultisigIsm {

        }

        impl HyperlaneChain for MockMultisigIsm {
            fn domain(&self) -> &HyperlaneDomain;
            fn provider(&self) -> Box<dyn HyperlaneProvider>;
        }

        impl HyperlaneContract for MockMultisigIsm {
            fn address(&self) -> H256;
        }

        #[async_trait::async_trait]
        impl MultisigIsm for MockMultisigIsm {
            async fn validators_and_threshold(
                &self,
                message: &HyperlaneMessage,
            ) -> ChainResult<(Vec<H256>, u8)>;
        }
    }

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
            .push_back(Err(MetadataBuildError::FailedToBuild(
                "No proof found".into(),
            )));

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

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_build_metadata_success_metric() {
        let mut message = HyperlaneMessage::default();
        message.origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism).id();
        message.destination = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum).id();

        let checkpoint = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                mailbox_domain: 100,
                merkle_tree_hook_address: H256::zero(),
                root: H256::zero(),
                index: 1000,
            },
            message_id: message.id(),
        };

        let mut validators: Vec<_> = dummy_validators().drain(..).take(1).collect();
        validators[0].latest_index = Some(1010);
        validators[0].fetch_checkpoint = Some(checkpoint.clone());

        let validator_addresses = validators
            .iter()
            .map(|validator| validator.public_key.parse::<H160>().unwrap().into())
            .collect::<Vec<H256>>();

        let syncers = build_mock_checkpoint_syncs(&validators).await;
        let syncers_dyn: HashMap<_, _> = syncers
            .into_iter()
            .map(|(key, value)| {
                let v: Arc<dyn CheckpointSyncer> = Arc::new(value);
                (key, v)
            })
            .collect();

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
            .push_back(Err(MetadataBuildError::FailedToBuild(
                "No proof found".into(),
            )));

        let multisig_syncer = MultisigCheckpointSyncer::new(syncers_dyn, None);

        base_builder
            .responses
            .build_checkpoint_syncer
            .lock()
            .unwrap()
            .push_back(Ok(multisig_syncer));

        let mut mock_multisig = MockMockMultisigIsm::new();
        mock_multisig
            .expect_validators_and_threshold()
            .once()
            .return_once(|_| Ok((validator_addresses, 1)));
        mock_multisig
            .expect_domain()
            .return_const(HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism));
        mock_multisig.expect_address().return_const(H256::zero());

        base_builder
            .responses
            .build_multisig_ism
            .lock()
            .unwrap()
            .push_back(Ok(Box::new(mock_multisig)));

        let ism_address = H256::zero();

        let base_builder_arc = Arc::new(base_builder);
        let message_builder = {
            let builder =
                MessageMetadataBuilder::new(base_builder_arc.clone(), ism_address, &message)
                    .await
                    .expect("Failed to build MessageMetadataBuilder");
            builder
        };
        let builder = MessageIdMultisigMetadataBuilder::new(message_builder);

        // build metadata
        let build_params = MessageMetadataBuildParams::default();
        builder
            .build(ism_address, &message, build_params)
            .await
            .expect("Failed to build metadata");

        // check if we called update_ism_metrics and with the correct arguments
        let expected = vec![IsmBuildMetricsParams {
            app_context: Some("test-app-context".to_string()),
            origin: HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
            destination: HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            ism_type: ModuleType::MessageIdMultisig,
            success: true,
        }];
        let update_ism_metrics_calls = base_builder_arc
            .requests
            .update_ism_metrics
            .lock()
            .unwrap()
            .clone();
        assert_eq!(update_ism_metrics_calls, expected);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_build_metadata_failed_metric() {
        let mut message = HyperlaneMessage::default();
        message.origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism).id();
        message.destination = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum).id();

        let mut validators: Vec<_> = dummy_validators().drain(..).take(1).collect();
        validators[0].latest_index = Some(1010);

        let validator_addresses = validators
            .iter()
            .map(|validator| validator.public_key.parse::<H160>().unwrap().into())
            .collect::<Vec<H256>>();

        let syncers = build_mock_checkpoint_syncs(&validators).await;
        let syncers_dyn: HashMap<_, _> = syncers
            .into_iter()
            .map(|(key, value)| {
                let v: Arc<dyn CheckpointSyncer> = Arc::new(value);
                (key, v)
            })
            .collect();

        let base_builder = build_mock_base_builder(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        );
        // insert responses required to build metadata successfully
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
            .push_back(Err(MetadataBuildError::FailedToBuild(
                "No proof found".into(),
            )));

        let multisig_syncer = MultisigCheckpointSyncer::new(syncers_dyn, None);

        base_builder
            .responses
            .build_checkpoint_syncer
            .lock()
            .unwrap()
            .push_back(Ok(multisig_syncer));

        let mut mock_multisig = MockMockMultisigIsm::new();
        mock_multisig
            .expect_validators_and_threshold()
            .once()
            .return_once(|_| Ok((validator_addresses, 1)));
        mock_multisig
            .expect_domain()
            .return_const(HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism));
        mock_multisig.expect_address().return_const(H256::zero());

        base_builder
            .responses
            .build_multisig_ism
            .lock()
            .unwrap()
            .push_back(Ok(Box::new(mock_multisig)));

        let ism_address = H256::zero();

        let base_builder_arc = Arc::new(base_builder);
        let message_builder = {
            let builder =
                MessageMetadataBuilder::new(base_builder_arc.clone(), ism_address, &message)
                    .await
                    .expect("Failed to build MessageMetadataBuilder");
            builder
        };
        let builder = MessageIdMultisigMetadataBuilder::new(message_builder);

        // build metadata
        let build_params = MessageMetadataBuildParams::default();
        let resp = builder.build(ism_address, &message, build_params).await;
        assert!(resp.is_err());

        // check if we called update_ism_metrics and with the correct arguments
        let expected = vec![IsmBuildMetricsParams {
            app_context: Some("test-app-context".to_string()),
            origin: HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
            destination: HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            ism_type: ModuleType::MessageIdMultisig,
            success: false,
        }];
        let update_ism_metrics_calls = base_builder_arc
            .requests
            .update_ism_metrics
            .lock()
            .unwrap()
            .clone();
        assert_eq!(update_ism_metrics_calls, expected);
    }
}
