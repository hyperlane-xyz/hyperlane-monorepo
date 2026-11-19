#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue

use std::{
    collections::{BTreeSet, HashSet},
    fmt::Debug,
    str::FromStr,
    sync::Arc,
    time::Instant,
};

use crate::message_activity::{Activity, Outcome, Stage, ValidatorStorageState};
use derive_new::new;
use futures::{future::BoxFuture, stream, StreamExt, TryStreamExt};
use hyperlane_ethereum::Signers;
use maplit::hashmap;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use hyperlane_base::{
    cache::{LocalCache, MeteredCache, OptionalCache},
    db::{HyperlaneDb, HyperlaneRocksDB},
    settings::{ChainConf, CheckpointSyncerBuildError, CheckpointSyncerConf},
    CheckpointSyncer, CoreMetrics, MultisigCheckpointSyncer,
};
use hyperlane_core::{
    accumulator::merkle::Proof, AggregationIsm, CcipReadIsm, Checkpoint, HyperlaneDomain,
    HyperlaneMessage, InterchainSecurityModule, ModuleType, MultisigIsm, RoutingIsm,
    ValidatorAnnounce, H160, H256, H512,
};
use hyperlane_sealevel::SealevelCompositeIsm;

use crate::msg::metadata::base_builder::validator_announced_storages::fetch_storage_locations_helper;
use crate::{merkle_tree::builder::MerkleTreeBuilder, msg::metadata::MetadataBuildError};

use super::{base::IsmCachePolicyClassifier, IsmAwareAppContextClassifier};

mod cached_checkpoint_syncer;
mod checkpoint_syncer_pool;
mod validator_announced_storages;

pub(crate) use checkpoint_syncer_pool::CheckpointSyncerPool;

type ReaderChange = (H160, Option<Arc<dyn CheckpointSyncer>>);
pub(crate) type CheckpointValidation = Result<Vec<ReaderChange>, CheckpointSyncerBuildError>;

pub struct CheckpointReaders<'a> {
    pub(crate) syncer: MultisigCheckpointSyncer,
    /// Check the selected readers and return only the readers that must change.
    pub(crate) validate: BoxFuture<'a, CheckpointValidation>,
}

struct SelectedReader {
    reader: Arc<dyn CheckpointSyncer>,
    older_locations: Vec<String>,
    states: BTreeSet<ValidatorStorageState>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct IsmBuildMetricsParams {
    pub app_context: Option<String>,
    pub origin: HyperlaneDomain,
    pub destination: HyperlaneDomain,
    pub ism_type: ModuleType,
    pub success: bool,
}

/// Base metadata builder with types used by higher level metadata builders.
#[allow(clippy::too_many_arguments)]
#[derive(new)]
pub struct BaseMetadataBuilder {
    origin_domain: HyperlaneDomain,
    destination_chain_setup: ChainConf,
    origin_prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    origin_validator_announce: Arc<dyn ValidatorAnnounce>,
    allow_local_checkpoint_syncers: bool,
    metrics: Arc<CoreMetrics>,
    cache: OptionalCache<MeteredCache<LocalCache>>,
    checkpoint_syncer_pool: CheckpointSyncerPool,
    db: HyperlaneRocksDB,
    app_context_classifier: IsmAwareAppContextClassifier,
    ism_cache_policy_classifier: IsmCachePolicyClassifier,
    signer: Option<Signers>,
    ignore_reorg_reports: bool,
    #[new(default)]
    activity_reporter: Option<crate::message_activity::MessageActivityReporter>,
}

impl BaseMetadataBuilder {
    pub fn with_activity_reporter(
        mut self,
        reporter: Option<crate::message_activity::MessageActivityReporter>,
    ) -> Self {
        self.activity_reporter = reporter;
        self
    }
}

impl Debug for BaseMetadataBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "BaseMetadataBuilder {{ origin_domain: {:?} destination_chain_setup: {:?}, validator_announce: {:?} }}",
            self.origin_domain, self.destination_chain_setup, self.origin_validator_announce
        )
    }
}

#[async_trait::async_trait]
pub trait BuildsBaseMetadata: Send + Sync + Debug {
    fn activity_reporter(&self) -> Option<&crate::message_activity::MessageActivityReporter> {
        None
    }
    fn report_node_activity(
        &self,
        message: &HyperlaneMessage,
        node_id: &str,
        activity: crate::message_activity::Activity,
    ) {
        if let Some(reporter) = self.activity_reporter() {
            reporter.report_node(message, node_id, activity);
        } else {
            self.report_activity(message, activity);
        }
    }

    fn report_activity(
        &self,
        message: &HyperlaneMessage,
        activity: crate::message_activity::Activity,
    ) {
        if let Some(reporter) = self.activity_reporter() {
            reporter.report(message, activity);
        }
    }

    fn origin_domain(&self) -> &HyperlaneDomain;
    fn destination_domain(&self) -> &HyperlaneDomain;
    fn app_context_classifier(&self) -> &IsmAwareAppContextClassifier;
    fn ism_cache_policy_classifier(&self) -> &IsmCachePolicyClassifier;
    fn cache(&self) -> &OptionalCache<MeteredCache<LocalCache>>;
    fn get_signer(&self) -> Option<&Signers>;

    fn update_ism_metric(&self, params: IsmBuildMetricsParams);

    /// Counts validator latest-index telemetry refreshes that were skipped or
    /// did not complete, so a stale `observed_validator_latest_index` is visible.
    fn report_latest_index_refresh_skipped(&self, _reason: &str) {}

    async fn get_proof(
        &self,
        leaf_index: u32,
        checkpoint: Checkpoint,
    ) -> Result<Proof, MetadataBuildError>;
    async fn highest_known_leaf_index(&self) -> Option<u32>;
    async fn get_merkle_leaf_id_by_message_id(&self, message_id: H256)
        -> eyre::Result<Option<u32>>;
    async fn retrieve_origin_tx_hash_by_message_id(
        &self,
        message_id: H256,
    ) -> eyre::Result<Option<H512>>;
    async fn build_ism(&self, address: H256) -> eyre::Result<Box<dyn InterchainSecurityModule>>;
    async fn build_routing_ism(&self, address: H256) -> eyre::Result<Box<dyn RoutingIsm>>;
    async fn build_multisig_ism(&self, address: H256) -> eyre::Result<Box<dyn MultisigIsm>>;
    async fn build_aggregation_ism(&self, address: H256) -> eyre::Result<Box<dyn AggregationIsm>>;
    async fn build_ccip_read_ism(&self, address: H256) -> eyre::Result<Box<dyn CcipReadIsm>>;
    async fn build_sealevel_composite_ism(
        &self,
        address: H256,
    ) -> eyre::Result<Arc<SealevelCompositeIsm>>;
    async fn discover_checkpoint_readers<'a>(
        &'a self,
        message: &'a HyperlaneMessage,
        validators: &[H256],
        app_context: Option<String>,
    ) -> Result<CheckpointReaders<'a>, CheckpointSyncerBuildError>;
}

#[async_trait::async_trait]
impl BuildsBaseMetadata for BaseMetadataBuilder {
    fn activity_reporter(&self) -> Option<&crate::message_activity::MessageActivityReporter> {
        self.activity_reporter.as_ref()
    }

    fn origin_domain(&self) -> &HyperlaneDomain {
        &self.origin_domain
    }

    fn destination_domain(&self) -> &HyperlaneDomain {
        &self.destination_chain_setup.domain
    }
    fn app_context_classifier(&self) -> &IsmAwareAppContextClassifier {
        &self.app_context_classifier
    }

    fn ism_cache_policy_classifier(&self) -> &IsmCachePolicyClassifier {
        &self.ism_cache_policy_classifier
    }

    fn cache(&self) -> &OptionalCache<MeteredCache<LocalCache>> {
        &self.cache
    }

    fn update_ism_metric(&self, params: IsmBuildMetricsParams) {
        let labels = hashmap! {
            "app_context" => params.app_context.as_deref().unwrap_or("Unknown"),
            "origin" => params.origin.name(),
            "remote" => params.destination.name(),
            "ism_type" => params.ism_type.as_str(),
            "status" => if params.success { "success" } else { "failure" },
        };
        self.metrics.ism_build_count().with(&labels).inc();
    }

    fn report_latest_index_refresh_skipped(&self, reason: &str) {
        self.metrics
            .validator_latest_index_refresh_skipped()
            .with_label_values(&[self.origin_domain.name(), reason])
            .inc();
    }

    async fn get_proof(
        &self,
        leaf_index: u32,
        checkpoint: Checkpoint,
    ) -> Result<Proof, MetadataBuildError> {
        let proof = self
            .origin_prover_sync
            .read()
            .await
            .get_proof(leaf_index, checkpoint.index)
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

        if proof.root() != checkpoint.root {
            info!(
                ?checkpoint,
                canonical_root = ?proof.root(),
                "Could not fetch metadata: checkpoint root does not match canonical root from merkle proof"
            );
            self.metrics.set_merkle_root_mismatch(self.origin_domain());

            return Err(MetadataBuildError::MerkleRootMismatch {
                root: checkpoint.root,
                canonical_root: proof.root(),
            });
        }
        Ok(proof)
    }

    async fn highest_known_leaf_index(&self) -> Option<u32> {
        self.origin_prover_sync.read().await.count().checked_sub(1)
    }

    async fn get_merkle_leaf_id_by_message_id(
        &self,
        message_id: H256,
    ) -> eyre::Result<Option<u32>> {
        let merkle_leaf = self
            .db
            .retrieve_merkle_leaf_index_by_message_id(&message_id)?;
        Ok(merkle_leaf)
    }

    async fn retrieve_origin_tx_hash_by_message_id(
        &self,
        message_id: H256,
    ) -> eyre::Result<Option<H512>> {
        // Older rows may hold Sealevel's zero placeholder; it is not a tx hash.
        Ok(self
            .db
            .retrieve_dispatched_tx_hash_by_message_id(&message_id)?
            .filter(|hash| *hash != H512::zero()))
    }

    async fn build_ism(&self, address: H256) -> eyre::Result<Box<dyn InterchainSecurityModule>> {
        self.destination_chain_setup
            .build_ism(address, &self.metrics)
            .await
    }

    async fn build_routing_ism(&self, address: H256) -> eyre::Result<Box<dyn RoutingIsm>> {
        self.destination_chain_setup
            .build_routing_ism(address, &self.metrics)
            .await
    }

    async fn build_multisig_ism(&self, address: H256) -> eyre::Result<Box<dyn MultisigIsm>> {
        self.destination_chain_setup
            .build_multisig_ism(address, &self.metrics)
            .await
    }

    async fn build_aggregation_ism(&self, address: H256) -> eyre::Result<Box<dyn AggregationIsm>> {
        self.destination_chain_setup
            .build_aggregation_ism(address, &self.metrics)
            .await
    }

    async fn build_ccip_read_ism(&self, address: H256) -> eyre::Result<Box<dyn CcipReadIsm>> {
        self.destination_chain_setup
            .build_ccip_read_ism(address, &self.metrics)
            .await
    }

    async fn build_sealevel_composite_ism(
        &self,
        address: H256,
    ) -> eyre::Result<Arc<SealevelCompositeIsm>> {
        self.destination_chain_setup
            .build_sealevel_composite_ism(address, &self.metrics)
            .await
            .map(Arc::new)
    }

    async fn discover_checkpoint_readers<'a>(
        &'a self,
        message: &'a HyperlaneMessage,
        validators: &[H256],
        app_context: Option<String>,
    ) -> Result<CheckpointReaders<'a>, CheckpointSyncerBuildError> {
        // Match the identity rules used to collect signatures. A malformed
        // bytes32 alias must not overwrite a canonical reader or its validation.
        let mut seen = HashSet::new();
        let validators: Vec<_> = validators
            .iter()
            .copied()
            .filter(|validator| {
                H256::from(H160::from(*validator)) == *validator && seen.insert(*validator)
            })
            .collect();
        let locations = self
            .fetch_storage_locations(&validators)
            .await
            .inspect_err(|_| {
                self.report_activity(
                    message,
                    Activity::Progress {
                        stage: Stage::ValidatorAnnouncements,
                        outcome: Outcome::Failed,
                    },
                );
            })?;
        debug!(
            hyp_message = ?message,
            ?validators,
            validators_len = validators.len(),
            storage_locations = ?locations,
            storage_locations_len = locations.len(),
            "List of validators and their storage locations for message"
        );

        let selected = stream::iter(validators.iter().copied().zip(locations).map(|(validator, mut locations)| async move {
            let mut states = BTreeSet::new();
            if locations.is_empty() {
                states.insert(ValidatorStorageState::NotAnnounced);
                warn!(?validator, "Validator has not announced any storage locations; see https://docs.hyperlane.xyz/docs/operators/validators/announcing-your-validator");
            }
            match self.select_reader(validator, &mut locations, &mut states).await {
                Some(reader) => Some((validator, SelectedReader { reader, older_locations: locations, states })),
                None => {
                    self.report_storage(message, validator, states, false);
                    None
                }
            }
        }))
        .buffer_unordered(10)
        .filter_map(std::future::ready)
        .collect::<Vec<_>>()
        .await;
        let checkpoint_syncers = selected
            .iter()
            .map(|(validator, selection)| ((*validator).into(), selection.reader.clone()))
            .collect();
        let syncer = MultisigCheckpointSyncer::new(
            checkpoint_syncers,
            app_context.map(|ctx| (self.metrics.clone(), ctx)),
        );
        let validator_count = validators.len();
        let validate = Box::pin(async move {
            let started = Instant::now();
            let results =
                stream::iter(selected.into_iter().map(|(validator, selection)| {
                    self.validate_reader(message, validator, selection)
                }))
                .buffer_unordered(10)
                .try_filter_map(|change| async move { Ok(change) })
                .try_collect()
                .await;
            debug!(
                message_id = ?message.id(),
                validator_count,
                elapsed_ms = started.elapsed().as_millis(),
                "Checked validator reorg flags"
            );
            results
        });
        Ok(CheckpointReaders { syncer, validate })
    }

    fn get_signer(&self) -> Option<&Signers> {
        self.signer.as_ref()
    }
}

impl BaseMetadataBuilder {
    /// Fetches storage locations for validators with caching.
    pub async fn fetch_storage_locations(
        &self,
        validators: &[H256],
    ) -> eyre::Result<Vec<Vec<String>>> {
        fetch_storage_locations_helper(validators, &self.cache, &*self.origin_validator_announce)
            .await
    }

    async fn select_reader(
        &self,
        validator: H256,
        locations: &mut Vec<String>,
        states: &mut BTreeSet<ValidatorStorageState>,
    ) -> Option<Arc<dyn CheckpointSyncer>> {
        while let Some(location) = locations.pop() {
            let Ok(config) = CheckpointSyncerConf::from_str(&location) else {
                states.insert(ValidatorStorageState::InvalidLocation);
                debug!(
                    ?validator,
                    ?location,
                    "Could not parse checkpoint syncer config for validator"
                );
                continue;
            };
            if !self.allow_local_checkpoint_syncers
                && matches!(config, CheckpointSyncerConf::LocalStorage { .. })
            {
                states.insert(ValidatorStorageState::LocalStorageDisabled);
                continue;
            }
            match self
                .checkpoint_syncer_pool
                .get_or_build(
                    &config,
                    self.cache.clone(),
                    self.origin_domain.name().to_string(),
                    validator,
                    location,
                )
                .await
            {
                Ok(reader) => return Some(reader),
                Err(err) => {
                    states.insert(ValidatorStorageState::LoadFailed);
                    debug!(error = %err, ?config, ?validator, "Error loading checkpoint syncer; trying the next location");
                }
            }
        }
        None
    }

    fn report_storage(
        &self,
        message: &HyperlaneMessage,
        validator: H256,
        states: BTreeSet<ValidatorStorageState>,
        usable: bool,
    ) {
        self.report_activity(
            message,
            Activity::ValidatorStorage {
                validator,
                states: states.into_iter().collect(),
                usable,
            },
        );
    }

    async fn validate_reader(
        &self,
        message: &HyperlaneMessage,
        validator: H256,
        SelectedReader {
            mut reader,
            mut older_locations,
            mut states,
        }: SelectedReader,
    ) -> Result<Option<ReaderChange>, CheckpointSyncerBuildError> {
        let key = validator.into();
        let mut changed = false;
        loop {
            match reader.reorg_status().await {
                Ok(event) if !event.exists => {
                    self.report_storage(message, validator, states, true);
                    return Ok(changed.then_some((key, Some(reader))));
                }
                Ok(event) => {
                    states.insert(ValidatorStorageState::ReorgReported);
                    if !self.ignore_reorg_reports {
                        self.report_storage(message, validator, states, false);
                        return Err(CheckpointSyncerBuildError::ReorgFlag(event));
                    }
                    states.insert(ValidatorStorageState::ReorgIgnored);
                    warn!(
                        ?event,
                        ?validator,
                        "Ignoring reorg report for checkpoint syncer"
                    );
                }
                Err(err) => {
                    // An older location cannot establish whether this unreadable flag is absent.
                    states.insert(ValidatorStorageState::ReorgCheckFailed);
                    warn!(
                        ?err,
                        ?validator,
                        "Failed to read reorg status; excluding validator from checkpoint metadata"
                    );
                    break;
                }
            }
            let Some(older_reader) = self
                .select_reader(validator, &mut older_locations, &mut states)
                .await
            else {
                break;
            };
            reader = older_reader;
            changed = true;
        }
        self.report_storage(message, validator, states, false);
        Ok(Some((key, None)))
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_base::db::DB;
    use hyperlane_core::{
        Announcement, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneProvider,
        ReorgEvent, ReorgPeriod, SignedType, TxOutcome, U256,
    };
    use mockall::mock;

    use crate::test_utils::dummy_data::dummy_metadata_builder;

    use super::*;

    mock! {
        #[derive(Debug)]
        pub Announce {}

        #[async_trait::async_trait]
        impl ValidatorAnnounce for Announce {
            async fn get_announced_storage_locations(
                &self,
                validators: &[H256],
            ) -> ChainResult<Vec<Vec<String>>>;

            async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome>;

            async fn announce_tokens_needed(
                &self,
                announcement: SignedType<Announcement>,
                chain_signer: H256,
            ) -> Option<U256>;
        }

        impl HyperlaneContract for Announce {
            fn address(&self) -> H256;
        }

        impl HyperlaneChain for Announce {
            fn domain(&self) -> &HyperlaneDomain;
            fn provider(&self) -> Box<dyn HyperlaneProvider>;
        }
    }

    #[tokio::test]
    async fn revalidates_reorg_status_on_every_pool_checkout() {
        let origin = HyperlaneDomain::new_test_domain("origin");
        let destination = HyperlaneDomain::new_test_domain("destination");
        let db_dir = tempfile::tempdir().unwrap();
        let db = HyperlaneRocksDB::new(&origin, DB::from_path(db_dir.path()).unwrap());
        let builder = dummy_metadata_builder(&origin, &destination, &db, OptionalCache::new(None));
        let checkpoint_dir = tempfile::tempdir().unwrap();
        let storage_location = format!("file://{}", checkpoint_dir.path().display());
        let validator = H256::from_low_u64_be(1);
        let mut builder = builder;
        builder.allow_local_checkpoint_syncers = true;
        let syncer = builder
            .select_reader(validator, &mut vec![storage_location], &mut BTreeSet::new())
            .await
            .unwrap();
        let message = HyperlaneMessage::default();
        let selected = || SelectedReader {
            reader: syncer.clone(),
            older_locations: Vec::new(),
            states: BTreeSet::new(),
        };
        assert!(builder
            .validate_reader(&message, validator, selected())
            .await
            .unwrap()
            .is_none());
        let reorg_event = ReorgEvent {
            local_merkle_root: H256::from_low_u64_be(2),
            canonical_merkle_root: H256::from_low_u64_be(3),
            checkpoint_index: 4,
            unix_timestamp: 5,
            reorg_period: ReorgPeriod::from_blocks(6),
        };
        syncer.write_reorg_status(&reorg_event).await.unwrap();

        // A pooled reader must still refuse delivery once a reorg report appears.
        let result = builder
            .validate_reader(&message, validator, selected())
            .await;
        assert!(matches!(
            result,
            Err(CheckpointSyncerBuildError::ReorgFlag(response)) if response.exists
        ));

        // A read error is not evidence that the flag is absent. A directory
        // deterministically causes a read error without relying on permissions.
        let flag = checkpoint_dir.path().join("reorg_flag.json");
        tokio::fs::remove_file(&flag).await.unwrap();
        tokio::fs::create_dir(&flag).await.unwrap();
        assert!(matches!(
            builder
                .validate_reader(&message, validator, selected())
                .await
                .unwrap(),
            Some((_, None))
        ));

        // A confirmed absence still permits metadata after the read recovers.
        tokio::fs::remove_dir(&flag).await.unwrap();
        assert!(builder
            .validate_reader(&message, validator, selected())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn unreadable_reorg_flag_excludes_only_that_validator() {
        let origin = HyperlaneDomain::new_test_domain("origin");
        let destination = HyperlaneDomain::new_test_domain("destination");
        let db_dir = tempfile::tempdir().unwrap();
        let db = HyperlaneRocksDB::new(&origin, DB::from_path(db_dir.path()).unwrap());
        let mut builder =
            dummy_metadata_builder(&origin, &destination, &db, OptionalCache::new(None));
        builder.allow_local_checkpoint_syncers = true;

        let healthy = H256::from_low_u64_be(1);
        let failing = H256::from_low_u64_be(2);
        let mut alias = healthy;
        alias.0[0] = 1;
        let validators = [healthy, alias, failing, healthy];
        let healthy_dir = tempfile::tempdir().unwrap();
        let failing_dir = tempfile::tempdir().unwrap();
        let healthy_location = format!("file://{}", healthy_dir.path().display());
        let failing_location = format!("file://{}", failing_dir.path().display());

        // Both validators have published checkpoints.
        for location in [&healthy_location, &failing_location] {
            CheckpointSyncerConf::from_str(location)
                .unwrap()
                .build_for_reading()
                .await
                .unwrap()
                .write_latest_index(7)
                .await
                .unwrap();
        }

        // A directory deterministically makes the failing validator's flag unreadable.
        tokio::fs::create_dir(failing_dir.path().join("reorg_flag.json"))
            .await
            .unwrap();

        let mut validator_announce = MockAnnounce::new();
        validator_announce
            .expect_domain()
            .return_const(origin.clone());
        // The older readable location must not bypass the newest unreadable flag,
        // whether the newest client was already pooled or is initialized now.
        let locations = vec![
            vec![healthy_location.clone()],
            vec![healthy_location, failing_location],
        ];
        validator_announce
            .expect_get_announced_storage_locations()
            .times(2)
            .withf(move |addresses| addresses == [healthy, failing])
            .returning(move |_| Ok(locations.clone()));
        builder.origin_validator_announce = Arc::new(validator_announce);

        let message = HyperlaneMessage::default();
        let CheckpointReaders {
            mut syncer,
            validate,
        } = builder
            .discover_checkpoint_readers(&message, &validators, None)
            .await
            .unwrap();

        // One unreadable flag must not fail the build for the other validators.
        let changes = validate.await.unwrap();
        assert!(
            matches!(changes.as_slice(), [(validator, None)] if *validator == H160::from(failing))
        );
        syncer.apply_reader_changes(changes);
        let latest = syncer
            .get_validator_latest_checkpoints_and_update_metrics(
                &[healthy, failing],
                &origin,
                &destination,
            )
            .await
            .unwrap();
        assert_eq!(latest, vec![(H160::from(healthy), 7)]);

        // An explicitly ignored flag permits trying an older location.
        let flag_path = failing_dir.path().join("reorg_flag.json");
        tokio::fs::remove_dir(&flag_path).await.unwrap();
        tokio::fs::write(&flag_path, b"{}").await.unwrap();
        builder.ignore_reorg_reports = true;
        let CheckpointReaders {
            syncer: _,
            validate,
        } = builder
            .discover_checkpoint_readers(&message, &validators, None)
            .await
            .unwrap();
        let changes = validate.await.unwrap();
        assert!(
            matches!(changes.as_slice(), [(validator, Some(_))] if *validator == H160::from(failing))
        );
    }
}
