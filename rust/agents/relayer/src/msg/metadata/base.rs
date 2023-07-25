use std::str::FromStr;
use std::sync::Arc;
use std::{collections::HashMap, fmt::Debug};

use async_trait::async_trait;
use derive_new::new;
use eyre::{Context, Result};
use tokio::sync::RwLock;
use tracing::{debug, info, instrument, warn};

use hyperlane_base::{
    ChainConf, CheckpointSyncer, CheckpointSyncerConf, CoreMetrics, MultisigCheckpointSyncer,
};
use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{
    Checkpoint, HyperlaneDomain, HyperlaneMessage, ModuleType, MultisigIsm, RoutingIsm,
    ValidatorAnnounce, H160, H256,
};

use crate::merkle_tree_builder::MerkleTreeBuilder;
use crate::msg::metadata::multisig::{
    LegacyMultisigMetadataBuilder, MerkleRootMultisigMetadataBuilder,
    MessageIdMultisigMetadataBuilder,
};
use crate::msg::metadata::RoutingIsmMetadataBuilder;

#[derive(Debug, thiserror::Error)]
pub enum MetadataBuilderError {
    #[error("Unknown or invalid module type ({0})")]
    UnsupportedModuleType(ModuleType),
    #[error("Exceeded max depth when building metadata ({0})")]
    MaxDepthExceeded(u32),
}

#[async_trait]
pub trait MetadataBuilder: Send + Sync {
    #[allow(clippy::async_yields_async)]
    async fn build(&self, ism_address: H256, message: &HyperlaneMessage)
        -> Result<Option<Vec<u8>>>;
}

#[derive(Clone, new)]
pub struct BaseMetadataBuilder {
    destination_chain_setup: ChainConf,
    origin_prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    origin_validator_announce: Arc<dyn ValidatorAnnounce>,
    allow_local_checkpoint_syncers: bool,
    metrics: Arc<CoreMetrics>,
    /// ISMs can be structured recursively. We keep track of the depth
    /// of the recursion to avoid infinite loops.
    #[new(default)]
    depth: u32,
    max_depth: u32,
}

impl Debug for BaseMetadataBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MetadataBuilder {{ chain_setup: {:?}, validator_announce: {:?} }}",
            self.destination_chain_setup, self.origin_validator_announce
        )
    }
}

#[async_trait]
impl MetadataBuilder for BaseMetadataBuilder {
    #[instrument(err, skip(self), fields(domain=self.domain().name()))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching module type";
        let ism = self
            .destination_chain_setup
            .build_ism(ism_address, &self.metrics)
            .await
            .context(CTX)?;
        let module_type = ism.module_type().await.context(CTX)?;
        let base = self.clone_with_incremented_depth()?;

        let metadata_builder: Box<dyn MetadataBuilder> = match module_type {
            ModuleType::LegacyMultisig => Box::new(LegacyMultisigMetadataBuilder::new(base)),
            ModuleType::MerkleRootMultisig => {
                Box::new(MerkleRootMultisigMetadataBuilder::new(base))
            }
            ModuleType::MessageIdMultisig => Box::new(MessageIdMultisigMetadataBuilder::new(base)),
            ModuleType::Routing => Box::new(RoutingIsmMetadataBuilder::new(base)),
            _ => return Err(MetadataBuilderError::UnsupportedModuleType(module_type).into()),
        };
        metadata_builder
            .build(ism_address, message)
            .await
            .context(CTX)
    }
}

impl BaseMetadataBuilder {
    pub fn domain(&self) -> &HyperlaneDomain {
        &self.destination_chain_setup.domain
    }

    pub fn clone_with_incremented_depth(&self) -> Result<BaseMetadataBuilder> {
        let mut cloned = self.clone();
        cloned.depth += 1;
        if cloned.depth > cloned.max_depth {
            Err(MetadataBuilderError::MaxDepthExceeded(cloned.depth).into())
        } else {
            Ok(cloned)
        }
    }

    pub async fn get_proof(&self, nonce: u32, checkpoint: Checkpoint) -> Result<Option<Proof>> {
        const CTX: &str = "When fetching message proof";
        let proof = self
            .origin_prover_sync
            .read()
            .await
            .get_proof(nonce, checkpoint.index)
            .context(CTX)?;

        // checkpoint may be fraudulent if the root does not
        // match the canonical root at the checkpoint's index
        if proof.root() != checkpoint.root {
            info!(
                ?checkpoint,
                canonical_root = ?proof.root(),
                "Could not fetch metadata: checkpoint root does not match canonical root from merkle proof"
            );
            Ok(None)
        } else {
            Ok(Some(proof))
        }
    }

    pub async fn highest_known_nonce(&self) -> u32 {
        self.origin_prover_sync.read().await.count() - 1
    }

    pub async fn build_routing_ism(&self, address: H256) -> Result<Box<dyn RoutingIsm>> {
        self.destination_chain_setup
            .build_routing_ism(address, &self.metrics)
            .await
    }

    pub async fn build_multisig_ism(&self, address: H256) -> Result<Box<dyn MultisigIsm>> {
        self.destination_chain_setup
            .build_multisig_ism(address, &self.metrics)
            .await
    }

    pub async fn build_checkpoint_syncer(
        &self,
        validators: &[H256],
    ) -> Result<MultisigCheckpointSyncer> {
        let storage_locations = self
            .origin_validator_announce
            .get_announced_storage_locations(validators)
            .await?;

        // Only use the most recently announced location for now.
        let mut checkpoint_syncers: HashMap<H160, Arc<dyn CheckpointSyncer>> = HashMap::new();
        for (&validator, validator_storage_locations) in validators.iter().zip(storage_locations) {
            for storage_location in validator_storage_locations.iter().rev() {
                let Ok(config) = CheckpointSyncerConf::from_str(storage_location) else {
                    debug!(?validator, ?storage_location, "Could not parse checkpoint syncer config for validator");
                    continue
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

                match config.build(None) {
                    Ok(checkpoint_syncer) => {
                        // found the syncer for this validator
                        checkpoint_syncers.insert(validator.into(), checkpoint_syncer.into());
                        break;
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
        Ok(MultisigCheckpointSyncer::new(checkpoint_syncers))
    }
}
