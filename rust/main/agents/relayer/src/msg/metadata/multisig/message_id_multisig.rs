use crate::message_activity::{Activity, Outcome, Stage};
use std::{
    collections::HashMap,
    fmt::Debug,
    sync::{Arc, LazyLock, Mutex, PoisonError},
    time::Duration,
};

use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;

use eyre::Result;
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{unwrap_or_none_result, HyperlaneMessage, ModuleType, H160, H256};
use tokio::{sync::Semaphore, time::timeout};
use tracing::{debug, warn};

use super::base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};
use crate::msg::metadata::{MessageMetadataBuilder, MetadataBuildError};

// Shared across messages; a slow storage backend cannot accumulate unbounded
// detached telemetry tasks. Pooled checkpoint syncers coalesce their reads.
// Each origin has its own permits so one origin's hanging validator storage
// cannot stop telemetry for every other origin; the global cap bounds the total.
static LATEST_INDEX_TELEMETRY_PERMITS: Semaphore = Semaphore::const_new(64);
static ORIGIN_LATEST_INDEX_TELEMETRY_PERMITS: LazyLock<Mutex<HashMap<String, Arc<Semaphore>>>> =
    LazyLock::new(Default::default);
const LATEST_INDEX_TELEMETRY_PERMITS_PER_ORIGIN: usize = 4;
const LATEST_INDEX_TELEMETRY_TIMEOUT: Duration = Duration::from_secs(30);
// Bounds how long a probe waits for latest indices before querying every validator.
const PROBE_LATEST_INDEX_TIMEOUT: Duration = Duration::from_secs(2);

fn origin_latest_index_telemetry_permits(origin: &str) -> Arc<Semaphore> {
    ORIGIN_LATEST_INDEX_TELEMETRY_PERMITS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .entry(origin.to_owned())
        .or_insert_with(|| Arc::new(Semaphore::new(LATEST_INDEX_TELEMETRY_PERMITS_PER_ORIGIN)))
        .clone()
}

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
        let probe_validators;
        let validators = if self.signature_polling {
            probe_validators = self
                .validators_that_may_have_signed(checkpoint_syncer, validators, leaf_index)
                .await;
            if probe_validators.len() < usize::from(threshold) {
                debug!(
                    leaf_index,
                    candidates = probe_validators.len(),
                    threshold,
                    "Too few validators have reached the leaf index to probe for a quorum"
                );
                return Ok(None);
            }
            probe_validators.as_slice()
        } else {
            validators
        };
        let quorum_checkpoint = checkpoint_syncer
            .fetch_checkpoint(
                validators,
                usize::from(threshold),
                leaf_index,
                self.base_builder().destination_domain(),
            )
            .await;

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

impl MessageIdMultisigMetadataBuilder {
    /// Signature probes repeat for every waiting message, so skip checkpoint GETs
    /// for validators whose shared, coalesced latest index is below the leaf.
    /// Validators without a readable latest index are still queried. This only
    /// narrows probes: normal builds query every validator, so a validator with
    /// a stale latest index still contributes its signature to delivery.
    async fn validators_that_may_have_signed(
        &self,
        checkpoint_syncer: &MultisigCheckpointSyncer,
        validators: &[H256],
        leaf_index: u32,
    ) -> Vec<H256> {
        let latest = match timeout(
            PROBE_LATEST_INDEX_TIMEOUT,
            checkpoint_syncer.get_validator_latest_checkpoints_and_update_metrics(
                validators,
                self.base_builder().origin_domain(),
                self.base_builder().destination_domain(),
            ),
        )
        .await
        {
            Ok(Ok(latest)) => latest.into_iter().collect::<HashMap<H160, u32>>(),
            Ok(Err(error)) => {
                debug!(?error, "Failed to read latest indices for signature probe");
                return validators.to_vec();
            }
            Err(_) => {
                debug!("Timed out reading latest indices for signature probe");
                return validators.to_vec();
            }
        };
        validators
            .iter()
            .filter(|validator| {
                latest
                    .get(&H160::from(**validator))
                    .is_none_or(|latest_index| *latest_index >= leaf_index)
            })
            .copied()
            .collect()
    }

    /// Refresh telemetry independently of checkpoint availability, with bounded
    /// concurrency and lifetime. Busy callers leave the active refreshes running.
    fn spawn_latest_index_telemetry(
        &self,
        checkpoint_syncer: &MultisigCheckpointSyncer,
        validators: &[H256],
    ) {
        let origin = self.base_builder().origin_domain().clone();
        let Ok(origin_permit) =
            origin_latest_index_telemetry_permits(origin.name()).try_acquire_owned()
        else {
            debug!("Latest-index telemetry for this origin is already at capacity");
            self.base_builder()
                .report_latest_index_refresh_skipped("capacity");
            return;
        };
        let Ok(permit) = LATEST_INDEX_TELEMETRY_PERMITS.try_acquire() else {
            debug!("Latest-index telemetry is already at capacity");
            self.base_builder()
                .report_latest_index_refresh_skipped("capacity");
            return;
        };
        let syncer = checkpoint_syncer.clone();
        let validators = validators.to_vec();
        let destination = self.base_builder().destination_domain().clone();
        let base_builder = self.base_builder().clone();
        tokio::spawn(async move {
            let _permits = (origin_permit, permit);
            match timeout(
                LATEST_INDEX_TELEMETRY_TIMEOUT,
                syncer.get_validator_latest_checkpoints_and_update_metrics(
                    &validators,
                    &origin,
                    &destination,
                ),
            )
            .await
            {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    debug!(?error, "Latest-index telemetry failed");
                    base_builder.report_latest_index_refresh_skipped("error");
                }
                Err(_) => {
                    debug!("Latest-index telemetry timed out");
                    base_builder.report_latest_index_refresh_skipped("timeout");
                }
            }
        });
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

    #[tokio::test]
    async fn ready_signatures_still_require_fresh_reorg_checks() {
        use crate::test_utils::mock_ism::MockInterchainSecurityModule;
        use hyperlane_base::settings::CheckpointSyncerBuildError;

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
        let mut validators: Vec<_> = dummy_validators().into_iter().take(1).collect();
        validators[0].fetch_checkpoint = Some(checkpoint);
        let address: H160 = validators[0].public_key.parse().unwrap();
        let clients = build_mock_checkpoint_syncs(&validators)
            .await
            .into_iter()
            .map(|(address, client)| {
                let client: Arc<dyn CheckpointSyncer> = Arc::new(client);
                (address, client)
            })
            .collect();
        let base = Arc::new(build_mock_base_builder(origin, destination.clone()));
        base.responses
            .build_checkpoint_syncer
            .lock()
            .unwrap()
            .extend([
                Ok(MultisigCheckpointSyncer::new(clients, None)),
                Err(CheckpointSyncerBuildError::ReorgFlag(ReorgEventResponse {
                    exists: true,
                    event: None,
                    content: None,
                })),
            ]);
        for _ in 0..2 {
            base.responses.push_build_ism_response(
                H256::zero(),
                Ok(Box::new(MockInterchainSecurityModule::new(
                    H256::zero(),
                    destination.clone(),
                    ModuleType::MessageIdMultisig,
                ))),
            );
            let mut ism = MockMockMultisigIsm::new();
            ism.expect_validators_and_threshold()
                .once()
                .return_once(move |_| Ok((vec![address.into()], 1)));
            ism.expect_domain().return_const(destination.clone());
            ism.expect_address().return_const(H256::zero());
            base.responses
                .build_multisig_ism
                .lock()
                .unwrap()
                .push_back(Ok(Box::new(ism)));
            base.responses
                .get_merkle_leaf_id_by_message_id
                .lock()
                .unwrap()
                .push_back(Ok(Some(1)));
        }
        let builder = MessageMetadataBuilder::new(base.clone(), H256::zero(), &message)
            .await
            .unwrap();
        assert!(matches!(
            builder
                .build_for_delivery(H256::zero(), &message, true)
                .await,
            Err(MetadataBuildError::Refused(_))
        ));
        assert_eq!(
            *base.requests.checkpoint_reorg_checks.lock().unwrap(),
            vec![false, true]
        );
    }

    #[tokio::test]
    async fn signature_probes_skip_validators_behind_the_leaf() {
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
        let syncers: HashMap<_, _> = build_mock_checkpoint_syncs(&validators)
            .await
            .into_iter()
            .map(|(k, v)| (k, Arc::new(v) as Arc<dyn CheckpointSyncer>))
            .collect();
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
            .extend([Ok(Some(1000)), Ok(Some(1000))]);
        let mut message_builder =
            MessageMetadataBuilder::new(Arc::new(base_builder), H256::zero(), &message)
                .await
                .unwrap();

        // The probe only queries validators that have reached the leaf, so it
        // cannot reach a threshold of two.
        message_builder.signature_polling = true;
        let probe = MessageIdMultisigMetadataBuilder::new(message_builder.clone());
        assert!(probe
            .fetch_metadata(&validator_addresses, 2, &message, &multisig_syncer)
            .await
            .unwrap()
            .is_none());

        // A normal build still queries every validator.
        message_builder.signature_polling = false;
        let normal = MessageIdMultisigMetadataBuilder::new(message_builder);
        assert!(normal
            .fetch_metadata(&validator_addresses, 2, &message, &multisig_syncer)
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
