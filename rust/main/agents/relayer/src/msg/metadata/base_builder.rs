#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue

use std::{collections::BTreeSet, fmt::Debug, str::FromStr, sync::Arc};

use crate::message_activity::{Activity, Outcome, Stage, ValidatorStorageState};
use derive_new::new;
use futures::{stream, StreamExt};
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
    ccip_read_allowed_domains: Arc<[String]>,
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
    fn ccip_read_allowed_domains(&self) -> &[String];
    fn get_signer(&self) -> Option<&Signers>;
    fn ignore_reorg_reports(&self) -> bool {
        false
    }

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
    async fn build_checkpoint_syncer(
        &self,
        message: &HyperlaneMessage,
        validators: &[H256],
        app_context: Option<String>,
    ) -> Result<MultisigCheckpointSyncer, CheckpointSyncerBuildError>;
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

    async fn build_checkpoint_syncer(
        &self,
        message: &HyperlaneMessage,
        validators: &[H256],
        app_context: Option<String>,
    ) -> Result<MultisigCheckpointSyncer, CheckpointSyncerBuildError> {
        let report = |outcome| {
            self.report_activity(
                message,
                Activity::Progress {
                    stage: Stage::ValidatorAnnouncements,
                    outcome,
                },
            );
        };
        let storage_locations = self
            .fetch_storage_locations(validators)
            .await
            .inspect_err(|_| report(Outcome::Failed))?;

        debug!(
            hyp_message=?message,
            ?validators,
            validators_len = ?validators.len(),
            ?storage_locations,
            storage_locations_len = ?storage_locations.len(),
            "List of validators and their storage locations for message");

        let result = validators
            .iter()
            .zip(storage_locations)
            .filter(|(validator, _)| H256::from(H160::from(**validator)) == **validator)
            .filter_map(|(validator, validator_storage_locations)| {
                debug!(hyp_message=?message, ?validator, ?validator_storage_locations, "Validator and its storage locations for message");
                if validator_storage_locations.is_empty() {
                    self.report_activity(message, Activity::ValidatorStorage { validator: *validator, states: vec![ValidatorStorageState::NotAnnounced], usable: false });
                    // If the validator has not announced any storage locations, we skip it
                    // and log a warning.
                    warn!(?validator, "Validator has not announced any storage locations; see https://docs.hyperlane.xyz/docs/operate/validators/run-validators#announcing-your-validator");
                    return None;
                }

                let future = async move {
                    let mut states = BTreeSet::new();
                    // Reverse the order of storage locations to prefer the most recently announced
                    for storage_location in validator_storage_locations.iter().rev() {
                        let Ok(config) = CheckpointSyncerConf::from_str(storage_location) else {
                            states.insert(ValidatorStorageState::InvalidLocation);
                            debug!(
                                ?validator,
                                ?storage_location,
                                "Could not parse checkpoint syncer config for validator"
                            );
                            continue;
                        };
                        // If this is a LocalStorage based checkpoint syncer and it's not
                        // allowed, ignore it
                        if !self.allow_local_checkpoint_syncers
                            && matches!(config, CheckpointSyncerConf::LocalStorage { .. })
                        {
                            states.insert(ValidatorStorageState::LocalStorageDisabled);
                            debug!(
                                ?config,
                                "Ignoring disallowed LocalStorage based checkpoint syncer"
                            );
                            continue;
                        }

                        let syncer = match self.checkpoint_syncer_pool.get_or_build(
                            &config,
                            self.cache.clone(),
                            self.origin_domain.name().to_string(),
                            *validator,
                            storage_location.clone(),
                        ).await {
                            Ok(syncer) => syncer,
                            Err(error) => {
                                states.insert(ValidatorStorageState::LoadFailed);
                                debug!(%error, ?config, ?validator, "Error loading checkpoint syncer; trying the next location");
                                continue;
                            }
                        };
                        self.report_activity(message, Activity::ValidatorStorage {
                            validator: *validator,
                            states: states.into_iter().collect(),
                            usable: true,
                        });
                        let syncer: Arc<dyn CheckpointSyncer> = syncer;
                        return Some(((*validator).into(), syncer));
                    }
                    warn!(
                        ?validator,
                        ?validator_storage_locations,
                        "No valid checkpoint syncer configs for validator"
                    );
                    self.report_activity(message, Activity::ValidatorStorage {
                        validator: *validator,
                        states: states.into_iter().collect(),
                        usable: false,
                    });
                    None
                };
                Some(future)
            })
            .collect::<Vec<_>>();

        let checkpoint_syncers = stream::iter(result)
            .buffer_unordered(10)
            .filter_map(std::future::ready)
            .collect()
            .await;

        Ok(MultisigCheckpointSyncer::new(
            checkpoint_syncers,
            app_context.map(|ctx| (self.metrics.clone(), ctx)),
        ))
    }

    fn ccip_read_allowed_domains(&self) -> &[String] {
        &self.ccip_read_allowed_domains
    }

    fn get_signer(&self) -> Option<&Signers> {
        self.signer.as_ref()
    }

    fn ignore_reorg_reports(&self) -> bool {
        self.ignore_reorg_reports
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
}
