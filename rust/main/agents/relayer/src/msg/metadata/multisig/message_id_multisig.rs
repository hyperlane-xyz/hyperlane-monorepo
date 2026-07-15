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
        let leaf_index = match self
            .base_builder()
            .get_merkle_leaf_id_by_message_id(message_id)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?
        {
            Some(idx) => idx,
            None => {
                debug!(
                    hyp_message=?message,
                    "No merkle leaf found for message id, must have not been enqueued in the tree"
                );
                return Err(MetadataBuildError::CouldNotFetch);
            }
        };

        // Updating the validator latest checkpoint metrics is independent of fetching the exact
        // message-id checkpoint. Run both storage operations concurrently so metrics collection
        // does not add another round trip to the metadata critical path.
        let ((), quorum_checkpoint) = tokio::join!(
            async {
                let _ = checkpoint_syncer
                    .get_validator_latest_checkpoints_and_update_metrics(
                        validators,
                        self.base_builder().origin_domain(),
                        self.base_builder().destination_domain(),
                    )
                    .await;
            },
            checkpoint_syncer.fetch_checkpoint(
                validators,
                usize::from(threshold),
                leaf_index,
                self.base_builder().destination_domain(),
            )
        );

        let quorum_checkpoint = unwrap_or_none_result!(
            quorum_checkpoint.map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?,
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
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    use hyperlane_base::tests::mock_checkpoint_syncer::{
        build_mock_checkpoint_syncs, generate_multisig_signed_checkpoint, MockCheckpointSyncer,
    };
    use hyperlane_base::tests::test_validators::dummy_validators;
    use hyperlane_base::{CheckpointSyncer, CoreMetrics, MultisigCheckpointSyncer};
    use hyperlane_core::{
        ChainResult, Checkpoint, CheckpointWithMessageId, HyperlaneChain, HyperlaneContract,
        HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, KnownHyperlaneDomain, ModuleType,
        MultisigIsm, ReorgEvent, ReorgEventResponse, SignedAnnouncement,
        SignedCheckpointWithMessageId, H160, H256,
    };
    use prometheus::Registry;
    use tokio::sync::Notify;

    use crate::msg::metadata::multisig::{
        MessageIdMultisigMetadataBuilder, MultisigIsmMetadataBuilder, MultisigMetadata,
    };
    use crate::msg::metadata::{
        IsmBuildMetricsParams, MessageMetadataBuildParams, MessageMetadataBuilder,
        MetadataBuildError, MetadataBuilder,
    };
    use crate::test_utils::mock_base_builder::build_mock_base_builder;

    #[derive(Debug)]
    struct GatedCheckpointSyncer {
        inner: MockCheckpointSyncer,
        latest_started: Arc<AtomicBool>,
        fetch_started: Arc<AtomicBool>,
        release: Arc<Notify>,
    }

    #[async_trait::async_trait]
    impl CheckpointSyncer for GatedCheckpointSyncer {
        async fn latest_index(&self) -> eyre::Result<Option<u32>> {
            self.latest_started.store(true, Ordering::SeqCst);
            self.release.notified().await;
            self.inner.latest_index().await
        }

        async fn write_latest_index(&self, index: u32) -> eyre::Result<()> {
            self.inner.write_latest_index(index).await
        }

        async fn fetch_checkpoint(
            &self,
            index: u32,
        ) -> eyre::Result<Option<SignedCheckpointWithMessageId>> {
            self.fetch_started.store(true, Ordering::SeqCst);
            self.release.notified().await;
            self.inner.fetch_checkpoint(index).await
        }

        async fn write_checkpoint(
            &self,
            signed_checkpoint: &SignedCheckpointWithMessageId,
        ) -> eyre::Result<()> {
            self.inner.write_checkpoint(signed_checkpoint).await
        }

        async fn write_metadata(&self, serialized_metadata: &str) -> eyre::Result<()> {
            self.inner.write_metadata(serialized_metadata).await
        }

        async fn write_announcement(
            &self,
            signed_announcement: &SignedAnnouncement,
        ) -> eyre::Result<()> {
            self.inner.write_announcement(signed_announcement).await
        }

        fn announcement_location(&self) -> String {
            self.inner.announcement_location()
        }

        async fn write_reorg_status(&self, reorg_event: &ReorgEvent) -> eyre::Result<()> {
            self.inner.write_reorg_status(reorg_event).await
        }

        async fn write_reorg_rpc_responses(&self, log: String) -> eyre::Result<()> {
            self.inner.write_reorg_rpc_responses(log).await
        }

        async fn reorg_status(&self) -> eyre::Result<ReorgEventResponse> {
            self.inner.reorg_status().await
        }
    }

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
        validators[0].fetch_checkpoint = Some(checkpoint);
        validators[1].latest_index = Some(1008);
        validators[2].latest_index = Some(1006);
        validators[3].latest_index = Some(1004);
        validators[3].fetch_checkpoint = Some(checkpoint);
        validators[4].latest_index = Some(1002);
        validators[4].fetch_checkpoint = Some(checkpoint);

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

    #[tokio::test]
    async fn fetches_latest_index_and_checkpoint_concurrently_and_updates_metrics() {
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

        let mut validators: Vec<_> = dummy_validators().drain(..).take(1).collect();
        validators[0].latest_index = Some(1010);
        validators[0].fetch_checkpoint = Some(checkpoint);

        let validator: H160 = validators[0]
            .public_key
            .parse()
            .expect("validator address should be valid");
        let validator_address = H256::from(validator);
        let mut syncers = build_mock_checkpoint_syncs(&validators).await;
        let inner = syncers
            .remove(&validator)
            .expect("validator syncer should exist");

        let latest_started = Arc::new(AtomicBool::new(false));
        let fetch_started = Arc::new(AtomicBool::new(false));
        let release = Arc::new(Notify::new());
        let gated_syncer = GatedCheckpointSyncer {
            inner,
            latest_started: latest_started.clone(),
            fetch_started: fetch_started.clone(),
            release: release.clone(),
        };
        let gated_syncer: Arc<dyn CheckpointSyncer> = Arc::new(gated_syncer);

        let origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism);
        let destination = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let app_context = "concurrent-fetch-test";
        let metrics = Arc::new(
            CoreMetrics::new("test-relayer", 9090, Registry::new())
                .expect("metrics should be created"),
        );
        let multisig_syncer = MultisigCheckpointSyncer::new(
            HashMap::from([(validator, gated_syncer)]),
            Some((metrics.clone(), app_context.to_owned())),
        );

        let base_builder = build_mock_base_builder(origin.clone(), destination.clone());
        base_builder
            .responses
            .get_merkle_leaf_id_by_message_id
            .lock()
            .expect("mock responses lock should not be poisoned")
            .push_back(Ok(Some(1000)));
        let message_builder =
            MessageMetadataBuilder::new(Arc::new(base_builder), H256::zero(), &message)
                .await
                .expect("message metadata builder should be created");
        let builder = MessageIdMultisigMetadataBuilder::new(message_builder);

        let validator_addresses = [validator_address];
        let mut fetch =
            Box::pin(builder.fetch_metadata(&validator_addresses, 1, &message, &multisig_syncer));

        assert!(
            futures::poll!(&mut fetch).is_pending(),
            "gated storage operations should keep metadata pending"
        );
        assert!(
            latest_started.load(Ordering::SeqCst),
            "latest-index collection should have started"
        );
        assert!(
            fetch_started.load(Ordering::SeqCst),
            "checkpoint fetching should start before latest-index collection completes"
        );

        release.notify_waiters();
        let metadata = fetch
            .await
            .expect("metadata fetch should succeed")
            .expect("metadata should be available");
        assert_eq!(metadata.checkpoint.index, checkpoint.index);

        let validator_label = format!("0x{validator:x}").to_lowercase();
        let observed_latest_index = metrics
            .validator_metrics
            .observed_validator_latest_index()
            .with_label_values(&[
                origin.as_ref(),
                destination.as_ref(),
                &validator_label,
                app_context,
            ])
            .get();
        assert_eq!(observed_latest_index, 1010);
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
        validators[0].fetch_checkpoint = Some(checkpoint);

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
