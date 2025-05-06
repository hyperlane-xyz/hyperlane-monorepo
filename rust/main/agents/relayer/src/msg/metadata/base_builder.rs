#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
#![allow(clippy::unnecessary_get_then_check)] // TODO: `rustc` 1.80.1 clippy issue

use std::{collections::HashMap, fmt::Debug, str::FromStr, sync::Arc};

use crate::merkle_tree::builder::MerkleTreeBuilder;
use derive_new::new;
use eyre::{eyre, Context};
use hyperlane_base::{
    cache::{LocalCache, MeteredCache},
    db::{HyperlaneDb, HyperlaneRocksDB},
    settings::CheckpointSyncerBuildError,
};
use hyperlane_base::{
    settings::{ChainConf, CheckpointSyncerConf},
    CheckpointSyncer, CoreMetrics, MultisigCheckpointSyncer,
};
use hyperlane_core::{
    accumulator::merkle::Proof, AggregationIsm, CcipReadIsm, Checkpoint, HyperlaneDomain,
    HyperlaneMessage, InterchainSecurityModule, MultisigIsm, RoutingIsm, ValidatorAnnounce, H160,
    H256,
};

use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use super::IsmAwareAppContextClassifier;

/// Base metadata builder with types used by higher level metadata builders.
#[allow(clippy::too_many_arguments)]
#[derive(new)]
pub struct BaseMetadataBuilder {
    origin_domain: HyperlaneDomain,
    destination_chain_setup: ChainConf,
    origin_prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    origin_validator_announce: Option<Arc<dyn ValidatorAnnounce>>,
    allow_local_checkpoint_syncers: bool,
    metrics: Arc<CoreMetrics>,
    cache: MeteredCache<LocalCache>,
    db: HyperlaneRocksDB,
    app_context_classifier: IsmAwareAppContextClassifier,
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
    fn origin_domain(&self) -> &HyperlaneDomain;
    fn destination_domain(&self) -> &HyperlaneDomain;
    fn app_context_classifier(&self) -> &IsmAwareAppContextClassifier;
    fn cache(&self) -> &MeteredCache<LocalCache>;

    async fn get_proof(&self, leaf_index: u32, checkpoint: Checkpoint) -> eyre::Result<Proof>;
    async fn highest_known_leaf_index(&self) -> Option<u32>;
    async fn get_merkle_leaf_id_by_message_id(&self, message_id: H256)
        -> eyre::Result<Option<u32>>;
    async fn build_ism(&self, address: H256) -> eyre::Result<Box<dyn InterchainSecurityModule>>;
    async fn build_routing_ism(&self, address: H256) -> eyre::Result<Box<dyn RoutingIsm>>;
    async fn build_multisig_ism(&self, address: H256) -> eyre::Result<Box<dyn MultisigIsm>>;
    async fn build_aggregation_ism(&self, address: H256) -> eyre::Result<Box<dyn AggregationIsm>>;
    async fn build_ccip_read_ism(&self, address: H256) -> eyre::Result<Box<dyn CcipReadIsm>>;
    async fn build_checkpoint_syncer(
        &self,
        message: &HyperlaneMessage,
        validators: &[H256],
        app_context: Option<String>,
    ) -> Result<MultisigCheckpointSyncer, CheckpointSyncerBuildError>;
}

#[async_trait::async_trait]
impl BuildsBaseMetadata for BaseMetadataBuilder {
    fn origin_domain(&self) -> &HyperlaneDomain {
        &self.origin_domain
    }

    fn destination_domain(&self) -> &HyperlaneDomain {
        &self.destination_chain_setup.domain
    }
    fn app_context_classifier(&self) -> &IsmAwareAppContextClassifier {
        &self.app_context_classifier
    }

    fn cache(&self) -> &MeteredCache<LocalCache> {
        &self.cache
    }

    async fn get_proof(&self, leaf_index: u32, checkpoint: Checkpoint) -> eyre::Result<Proof> {
        const CTX: &str = "When fetching message proof";
        let proof = self
            .origin_prover_sync
            .read()
            .await
            .get_proof(leaf_index, checkpoint.index)
            .context(CTX)?;

        if proof.root() != checkpoint.root {
            info!(
                ?checkpoint,
                canonical_root = ?proof.root(),
                "Could not fetch metadata: checkpoint root does not match canonical root from merkle proof"
            );
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

    async fn build_checkpoint_syncer(
        &self,
        message: &HyperlaneMessage,
        validators: &[H256],
        app_context: Option<String>,
    ) -> Result<MultisigCheckpointSyncer, CheckpointSyncerBuildError> {
        // Handle the optional origin_validator_announce
        let Some(origin_validator_announce) = self.origin_validator_announce.as_ref() else {
            warn!(hyp_message=?message, origin_domain=%self.origin_domain.name(), "Attempted to build checkpoint syncer for message, but origin chain has no ValidatorAnnounce configured.");
            return Err(CheckpointSyncerBuildError::Other(eyre!(
                "Origin chain {} has no ValidatorAnnounce configured, cannot build checkpoint syncer based on announcements.",
                self.origin_domain.name()
            )));
        };

        let storage_locations = origin_validator_announce
            .get_announced_storage_locations(validators)
            .await?;

        debug!(
            hyp_message=?message,
            ?validators,
            validators_len = ?validators.len(),
            ?storage_locations,
            storage_locations_len = ?storage_locations.len(),
            "List of validators and their storage locations for message");

        // Only use the most recently announced location for now.
        let mut checkpoint_syncers: HashMap<H160, Arc<dyn CheckpointSyncer>> = HashMap::new();
        for (&validator, validator_storage_locations) in validators.iter().zip(storage_locations) {
            debug!(hyp_message=?message, ?validator, ?validator_storage_locations, "Validator and its storage locations for message");
            for storage_location in validator_storage_locations.iter().rev() {
                let Ok(config) = CheckpointSyncerConf::from_str(storage_location) else {
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
                    debug!(
                        ?config,
                        "Ignoring disallowed LocalStorage based checkpoint syncer"
                    );
                    continue;
                }

                match config.build_and_validate(None).await {
                    Ok(checkpoint_syncer) => {
                        // found the syncer for this validator
                        checkpoint_syncers.insert(validator.into(), checkpoint_syncer.into());
                        break;
                    }
                    Err(CheckpointSyncerBuildError::ReorgEvent(reorg_event)) => {
                        // If a reorg event has been posted to a checkpoint syncer,
                        // we refuse to build
                        return Err(CheckpointSyncerBuildError::ReorgEvent(reorg_event));
                    }
                    Err(err) => {
                        debug!(
                            error=%err,
                            ?config,
                            ?validator,
                            "Error when loading checkpoint syncer; will attempt to use the next config"
                        );
                    }
                }
            }
            if checkpoint_syncers.get(&validator.into()).is_none() {
                if validator_storage_locations.is_empty() {
                    warn!(?validator, "Validator has not announced any storage locations; see https://docs.hyperlane.xyz/docs/operators/validators/announcing-your-validator");
                } else {
                    warn!(
                        ?validator,
                        ?validator_storage_locations,
                        "No valid checkpoint syncer configs for validator"
                    );
                }
            }
        }
        Ok(MultisigCheckpointSyncer::new(
            checkpoint_syncers,
            self.metrics.clone(),
            app_context,
        ))
    }
}
