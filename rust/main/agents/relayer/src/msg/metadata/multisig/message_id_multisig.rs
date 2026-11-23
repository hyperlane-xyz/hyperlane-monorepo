use crate::message_activity::{Activity, Outcome, Stage};
use std::fmt::Debug;

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::Result;
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, ModuleType, H256};
use tracing::{debug, warn};

use super::base::{checkpoint_error, MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};
use crate::msg::metadata::{MessageMetadataBuilder, MetadataBuildError};

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct MessageIdMultisigMetadataBuilder(MessageMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for MessageIdMultisigMetadataBuilder {
    fn module_type(&self) -> ModuleType {
        ModuleType::MessageIdMultisig
    }

    fn token_layout(&self) -> &'static [MetadataToken] {
        &[
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
        let report = |outcome| {
            self.report_activity(
                message,
                Activity::Progress {
                    stage: Stage::MerkleLeaf,
                    outcome,
                },
            )
        };
        report(Outcome::Started);
        let message_id = message.id();
        let leaf_index = match self
            .base_builder()
            .get_merkle_leaf_id_by_message_id(message_id)
            .await
            .map_err(|err| {
                report(Outcome::Failed);
                MetadataBuildError::FailedToBuild(err.to_string())
            })? {
            Some(idx) => idx,
            None => {
                report(Outcome::Unavailable);
                debug!(
                    hyp_message=?message,
                    "No merkle leaf found for message id, must have not been enqueued in the tree"
                );
                return Err(MetadataBuildError::CouldNotFetch);
            }
        };

        report(Outcome::Succeeded);
        self.report_activity(
            message,
            Activity::MerkleLeaf {
                index: leaf_index,
                highest_known: None,
            },
        );
        // The exact checkpoint index is already known. Availability probes do
        // not need latest-index GETs; telemetry stays on the normal build path.
        if !self.signature_polling {
            self.spawn_latest_index_telemetry(checkpoint_syncer, validators);
        }
        let syncer = checkpoint_syncer
            .clone()
            .with_signature_polling(Some(message_id), self.signature_poll_retry);
        let quorum_checkpoint = syncer
            .fetch_checkpoint(
                validators,
                threshold.into(),
                leaf_index,
                self.base_builder().destination_domain(),
            )
            .await;

        let quorum_checkpoint = unwrap_or_none_result!(
            quorum_checkpoint.map_err(checkpoint_error)?,
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
        Arc, Mutex,
    };

    use hyperlane_base::tests::mock_checkpoint_syncer::{
        build_mock_checkpoint_syncs, generate_multisig_signed_checkpoint, MockCheckpointSyncer,
    };
    use hyperlane_base::tests::test_validators::dummy_validators;
    use hyperlane_base::{
        CheckpointObservation, CheckpointObserver, CheckpointSyncer, CoreMetrics,
        MultisigCheckpointSyncer,
    };
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
    use crate::msg::pending_message::build_until_signature_miss;
    use crate::test_utils::mock_base_builder::build_mock_base_builder;

    #[derive(Debug, Default)]
    struct LatestIndexObserver(Mutex<HashMap<H160, Option<u32>>>);

    impl CheckpointObserver for LatestIndexObserver {
        fn observe(&self, observation: CheckpointObservation) {
            if let CheckpointObservation::LatestIndex { validator, index } = observation {
                self.0
                    .lock()
                    .expect("observer lock should not be poisoned")
                    .insert(validator, index);
            }
        }
    }

    #[derive(Debug)]
    struct GatedCheckpointSyncer {
        inner: MockCheckpointSyncer,
        latest_started: Arc<AtomicBool>,
        fetch_started: Arc<AtomicBool>,
        release: Arc<Notify>,
        release_latest: Arc<Notify>,
        release_reorg: Option<Arc<Notify>>,
    }

    #[async_trait::async_trait]
    impl CheckpointSyncer for GatedCheckpointSyncer {
        async fn latest_index(&self) -> eyre::Result<Option<u32>> {
            self.latest_started.store(true, Ordering::SeqCst);
            self.release_latest.notified().await;
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
            if let Some(release) = &self.release_reorg {
                release.notified().await;
            }
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

    #[tokio::test(start_paused = true)]
    async fn delivery_preserves_quorum_and_reorg_checks_across_signature_waits() {
        use crate::test_utils::mock_ism::MockInterchainSecurityModule;

        let origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism);
        let destination = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let message = HyperlaneMessage::default();
        let checkpoint = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                mailbox_domain: message.origin,
                merkle_tree_hook_address: H256::zero(),
                root: H256::zero(),
                index: 1,
            },
            message_id: message.id(),
        };
        let mut validators: Vec<_> = dummy_validators().into_iter().take(2).collect();
        validators[0].fetch_checkpoint = Some(checkpoint);
        validators[1].fetch_checkpoint = Some(checkpoint);
        let signed = generate_multisig_signed_checkpoint(&validators, checkpoint).await;
        let expected_signature = signed.signatures[0].to_vec();
        let expected_second_signature = signed.signatures[1].to_vec();
        let addresses: Vec<H256> = validators
            .iter()
            .map(|validator| {
                validator
                    .public_key
                    .parse::<H160>()
                    .expect("valid address")
                    .into()
            })
            .collect();
        for (
            positive,
            signer_blocked,
            retry,
            unreadable_reader,
            warm,
            retain_signature,
            one_shot_miss,
        ) in [
            (false, false, false, None, false, false, false),
            (true, false, false, None, false, false, false),
            (true, true, false, None, false, false, false),
            (true, false, true, None, false, false, false),
            (false, false, false, Some(1), false, false, false),
            (false, false, false, Some(0), false, false, false),
            (false, false, false, None, true, false, false),
            (false, false, true, None, false, true, false),
            (false, false, false, None, false, false, true),
        ] {
            let mut readers = validators.clone();
            if one_shot_miss {
                readers[0].fetch_checkpoint = None;
            }
            if !retain_signature {
                readers[1].fetch_checkpoint = None;
            }
            let mut clients = build_mock_checkpoint_syncs(&readers).await;
            let signing = clients.remove(&H160::from(addresses[0])).expect("signer");
            let non_signing = clients
                .remove(&H160::from(addresses[1]))
                .expect("non-signer");
            let signature_responses = signing.responses.fetch_checkpoint.clone();
            let signing_flags = signing.responses.reorg_status.clone();
            let flag_response = non_signing.responses.reorg_status.clone();
            let other_signatures = non_signing.responses.fetch_checkpoint.clone();
            {
                let mut flags = flag_response.lock().expect("reorg response lock");
                flags.clear();
                flags.push_back(if unreadable_reader == Some(1) {
                    Err(eyre::eyre!("non-signer flags unavailable"))
                } else {
                    Ok(ReorgEventResponse {
                        exists: positive,
                        event: None,
                        content: None,
                    })
                });
            }
            let release = Arc::new(Notify::new());
            if retry {
                signature_responses
                    .lock()
                    .expect("signature response lock")
                    .push_front(Ok(None));
                if !positive {
                    release.notify_one();
                }
            }
            if unreadable_reader == Some(0) {
                let mut flags = signing_flags.lock().expect("signer flag lock");
                let _ = flags.pop_front();
                flags.push_front(Err(eyre::eyre!("signer flags unavailable")));
            }
            let fetch_started = Arc::new(AtomicBool::new(false));
            let gated = |inner, release_reorg, fetch_started| GatedCheckpointSyncer {
                inner,
                latest_started: Arc::new(AtomicBool::new(false)),
                fetch_started,
                release: Arc::new(Notify::new()),
                release_latest: Arc::new(Notify::new()),
                release_reorg,
            };
            let signing: Arc<dyn CheckpointSyncer> = if signer_blocked {
                Arc::new(gated(
                    signing,
                    Some(Arc::new(Notify::new())),
                    fetch_started.clone(),
                ))
            } else {
                Arc::new(signing)
            };
            let non_signing: Arc<dyn CheckpointSyncer> =
                if warm || retain_signature || one_shot_miss {
                    Arc::new(non_signing)
                } else {
                    Arc::new(gated(
                        non_signing,
                        Some(release.clone()),
                        Arc::new(AtomicBool::new(false)),
                    ))
                };
            let syncer = MultisigCheckpointSyncer::new(
                HashMap::from([
                    (H160::from(addresses[0]), signing),
                    (H160::from(addresses[1]), non_signing),
                ]),
                None,
            );
            let base = Arc::new(build_mock_base_builder(origin.clone(), destination.clone()));
            base.responses
                .build_checkpoint_syncer
                .lock()
                .expect("mock response lock")
                .push_back(Ok(syncer));
            base.responses.push_build_ism_response(
                H256::zero(),
                Ok(Box::new(MockInterchainSecurityModule::new(
                    H256::zero(),
                    destination.clone(),
                    ModuleType::MessageIdMultisig,
                ))),
            );
            let mut ism = MockMockMultisigIsm::new();
            let mut validators = addresses.clone();
            if warm {
                // Visit the optional, missing reader before the first-pass signer.
                validators.reverse();
            }
            let threshold = if retain_signature { 2 } else { 1 };
            ism.expect_validators_and_threshold()
                .once()
                .return_once(move |_| Ok((validators, threshold)));
            ism.expect_domain().return_const(destination.clone());
            ism.expect_address().return_const(H256::zero());
            base.responses
                .build_multisig_ism
                .lock()
                .expect("mock response lock")
                .push_back(Ok(Box::new(ism)));
            base.responses
                .get_merkle_leaf_id_by_message_id
                .lock()
                .expect("mock response lock")
                .push_back(Ok(Some(1)));
            let builder = MessageMetadataBuilder::new(base, H256::zero(), &message)
                .await
                .expect("message metadata builder");
            let message = message.clone();
            let build = async move {
                let retry = if one_shot_miss {
                    None
                } else {
                    builder.signature_poll_retry
                };
                builder
                    .build_for_delivery(H256::zero(), &message, true, retry)
                    .await
            };
            if one_shot_miss {
                let result = build_until_signature_miss(build).await;
                assert!(matches!(
                    result,
                    Ok(Err(MetadataBuildError::AwaitingValidatorSignatures))
                ));
                assert!(signature_responses
                    .lock()
                    .expect("first reader lock")
                    .is_empty());
                assert!(other_signatures
                    .lock()
                    .expect("second reader lock")
                    .is_empty());
                continue;
            }
            if warm {
                let result = build_until_signature_miss(build).await;
                let Ok(Ok(metadata)) = result else {
                    panic!("first-pass quorum should finish without parking");
                };
                assert!(metadata.ends_with(&expected_signature));
                assert!(other_signatures
                    .lock()
                    .expect("optional signer lock")
                    .is_empty());
                continue;
            }
            let build = if retry {
                match build_until_signature_miss(build).await {
                    Err(waiting) => waiting,
                    Ok(_) => panic!("first confirmed miss should yield a suspended build"),
                }
            } else {
                Box::pin(build)
            };
            tokio::pin!(build);
            assert!(futures::poll!(&mut build).is_pending());
            assert_eq!(
                signature_responses
                    .lock()
                    .expect("signature response lock")
                    .len(),
                usize::from(signer_blocked || retry)
            );
            if signer_blocked {
                assert!(fetch_started.load(Ordering::SeqCst));
            }
            if retain_signature {
                assert!(other_signatures
                    .lock()
                    .expect("second signer lock")
                    .is_empty());
            }
            if !retry || positive {
                release.notify_one();
            }
            let result = tokio::time::timeout(std::time::Duration::from_secs(1), build)
                .await
                .expect("a positive flag must not wait for another reader");
            if positive {
                assert!(matches!(result, Err(MetadataBuildError::Refused(_))));
            } else {
                let metadata = result.expect("quorum remains usable without a positive flag");
                if retain_signature {
                    assert!(metadata.ends_with(
                        &[
                            expected_signature.as_slice(),
                            expected_second_signature.as_slice()
                        ]
                        .concat(),
                    ));
                } else {
                    assert!(metadata.ends_with(&expected_signature));
                }
                assert_eq!(signing_flags.lock().expect("signer flag lock").len(), 1);
                assert!(flag_response
                    .lock()
                    .expect("non-signer flag lock")
                    .is_empty());
            }
        }
    }

    #[tokio::test]
    async fn exact_fetch_accepts_signatures_ahead_of_latest_index() {
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

        let mut validators: Vec<_> = dummy_validators().drain(..).take(2).collect();
        validators[0].latest_index = Some(1010);
        validators[0].fetch_checkpoint = Some(checkpoint);
        // Signed, but its latest index has not been published yet.
        validators[1].latest_index = Some(990);
        validators[1].fetch_checkpoint = Some(checkpoint);
        let validator_addresses = validators
            .iter()
            .map(|validator| validator.public_key.parse::<H160>().unwrap().into())
            .collect::<Vec<_>>();
        // Mock syncers answer each checkpoint fetch once, so each phase gets its own.
        let multisig_syncer = || async {
            let syncers: HashMap<_, _> = build_mock_checkpoint_syncs(&validators)
                .await
                .into_iter()
                .map(|(k, v)| (k, Arc::new(v) as Arc<dyn CheckpointSyncer>))
                .collect();
            MultisigCheckpointSyncer::new(syncers, None)
        };

        let base_builder = build_mock_base_builder(
            HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        );
        base_builder
            .responses
            .get_merkle_leaf_id_by_message_id
            .lock()
            .unwrap()
            .extend([Ok(Some(1000)), Ok(Some(1000)), Ok(Some(1000))]);
        let mut message_builder =
            MessageMetadataBuilder::new(Arc::new(base_builder), H256::zero(), &message)
                .await
                .unwrap();

        message_builder.signature_polling = true;
        let builder = MessageIdMultisigMetadataBuilder::new(message_builder);
        assert!(builder
            .fetch_metadata(&validator_addresses, 2, &message, &multisig_syncer().await)
            .await
            .unwrap()
            .is_some());
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
    async fn latest_index_telemetry_finishes_after_checkpoint_quorum() {
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

        let mut validators: Vec<_> = dummy_validators().drain(..).take(3).collect();
        for validator in &mut validators {
            validator.latest_index = Some(1010);
            validator.fetch_checkpoint = Some(checkpoint);
        }
        let validator_addresses: Vec<H256> = validators
            .iter()
            .map(|validator| {
                validator
                    .public_key
                    .parse::<H160>()
                    .expect("validator address should be valid")
                    .into()
            })
            .collect();
        let slow_validator = H160::from(validator_addresses[0]);
        let syncers = build_mock_checkpoint_syncs(&validators).await;
        let latest_started = Arc::new(AtomicBool::new(false));
        let fetch_started = Arc::new(AtomicBool::new(false));
        let release = Arc::new(Notify::new());
        let release_latest = Arc::new(Notify::new());
        let syncers = syncers
            .into_iter()
            .map(|(validator, inner)| {
                let gated_syncer: Arc<dyn CheckpointSyncer> = Arc::new(GatedCheckpointSyncer {
                    inner,
                    latest_started: latest_started.clone(),
                    fetch_started: fetch_started.clone(),
                    release: release.clone(),
                    release_reorg: None,
                    release_latest: if validator == slow_validator {
                        release_latest.clone()
                    } else {
                        let ready = Arc::new(Notify::new());
                        ready.notify_one();
                        ready
                    },
                });
                (validator, gated_syncer)
            })
            .collect();

        let origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism);
        let destination = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let app_context = "concurrent-fetch-test";
        let metrics = Arc::new(
            CoreMetrics::new("test-relayer", 9090, Registry::new())
                .expect("metrics should be created"),
        );
        let observer = Arc::new(LatestIndexObserver::default());
        let multisig_syncer =
            MultisigCheckpointSyncer::new(syncers, Some((metrics.clone(), app_context.to_owned())))
                .with_observer(observer.clone());

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

        let mut fetch =
            Box::pin(builder.fetch_metadata(&validator_addresses, 2, &message, &multisig_syncer));

        assert!(
            futures::poll!(&mut fetch).is_pending(),
            "gated storage operations should keep metadata pending"
        );
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while !latest_started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("latest-index collection should have started");
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

        let gauges: Vec<_> = validator_addresses
            .iter()
            .map(|validator| {
                metrics
                    .validator_metrics
                    .observed_validator_latest_index()
                    .with_label_values(&[
                        origin.as_ref(),
                        destination.as_ref(),
                        &format!("0x{:x}", H160::from(*validator)),
                        app_context,
                    ])
            })
            .collect();
        assert!(gauges.iter().all(|gauge| gauge.get() == 0));
        assert!(observer
            .0
            .lock()
            .expect("observer lock should not be poisoned")
            .is_empty());

        // The metadata future is gone. Releasing the slow third latest-index
        // read must still publish telemetry for all three validators.
        release_latest.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while gauges.iter().any(|gauge| gauge.get() != 1010) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("telemetry should finish after metadata has returned");
        let observations = observer
            .0
            .lock()
            .expect("observer lock should not be poisoned");
        for validator in validator_addresses {
            assert_eq!(observations.get(&H160::from(validator)), Some(&Some(1010)));
        }
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
        let mut message_builder = {
            let builder =
                MessageMetadataBuilder::new(base_builder_arc.clone(), ism_address, &message)
                    .await
                    .expect("Failed to build MessageMetadataBuilder");
            builder
        };
        message_builder.signature_poll_retry = None;
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
