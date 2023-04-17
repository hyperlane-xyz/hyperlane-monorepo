use async_trait::async_trait;
use hyperlane_core::accumulator::merkle::Proof;
use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use std::str::FromStr;
use std::sync::Arc;
use std::{collections::HashMap, fmt::Debug};

use derive_new::new;
use eyre::{Context, Result};
use tokio::sync::RwLock;
use tracing::{debug, instrument, warn};

use hyperlane_base::{
    ChainConf, CheckpointSyncer, CheckpointSyncerConf, CoreMetrics, MultisigCheckpointSyncer,
};
use hyperlane_core::{HyperlaneMessage, ValidatorAnnounce, H160, H256, MultisigIsm, MultisigSignedCheckpoint, RoutingIsm};

use crate::merkle_tree_builder::MerkleTreeBuilder;
use crate::msg::metadata::{MultisigIsmMetadataBuilder, RoutingIsmMetadataBuilder};

#[derive(Debug, thiserror::Error)]
pub enum MetadataBuilderError {
    #[error("Unknown or invalid module type ({0})")]
    UnsupportedModuleType(u8),
    #[error("Exceeded max depth when building metadata ({0})")]
    MaxDepthExceeded(u32),
}

#[derive(FromPrimitive, Clone, Debug)]
pub enum SupportedIsmTypes {
    Routing = 1,
    // Aggregation = 2,
    LegacyMultisig = 3,
    Multisig = 4,
}

#[async_trait]
pub trait MetadataBuilder: Send + Sync {
    #[allow(clippy::async_yields_async)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>>;
}

#[derive(Clone, new)]
pub struct BaseMetadataBuilder {
    chain_setup: ChainConf,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    validator_announce: Arc<dyn ValidatorAnnounce>,
    allow_local_checkpoint_syncers: bool,
    metrics: Arc<CoreMetrics>,
    depth: u32,
    max_depth: u32,
}

impl Debug for BaseMetadataBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MetadataBuilder {{ chain_setup: {:?}, validator_announce: {:?} }}",
            self.chain_setup, self.validator_announce
        )
    }
}

#[async_trait]
impl MetadataBuilder for BaseMetadataBuilder {
    #[instrument(err)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching module type";
        let ism = self
            .chain_setup
            .build_ism(ism_address, &self.metrics)
            .await
            .context(CTX)?;
        let module_type = ism.module_type().await.context(CTX)?;
        let supported_type = SupportedIsmTypes::from_u8(module_type)
            .ok_or(MetadataBuilderError::UnsupportedModuleType(module_type))
            .context(CTX)?;
        let base = self.clone_with_incremented_depth()?;

        let metadata_builder: Box<dyn MetadataBuilder> = match supported_type {
            SupportedIsmTypes::Multisig => Box::new(MultisigIsmMetadataBuilder::new(base, false)),
            SupportedIsmTypes::LegacyMultisig => {
                Box::new(MultisigIsmMetadataBuilder::new(base, true))
            }
            SupportedIsmTypes::Routing => Box::new(RoutingIsmMetadataBuilder::new(base)),
        };
        metadata_builder
            .build(ism_address, message)
            .await
            .context(CTX)
    }
}

impl BaseMetadataBuilder {
    pub fn clone_with_incremented_depth(&self) -> eyre::Result<BaseMetadataBuilder> {
        let mut cloned = self.clone();
        cloned.depth += 1;
        if cloned.depth > cloned.max_depth {
            Err(MetadataBuilderError::MaxDepthExceeded(cloned.depth).into())
        } else {
            Ok(cloned)
        }
    }

    pub async fn get_proof(
        &self,
        message: &HyperlaneMessage,
    checkpoint: MultisigSignedCheckpoint) -> Result<Proof> {
        const CTX: &str = "When fetching message proof";
        self
            .prover_sync
            .read()
            .await
            .get_proof(message.nonce, checkpoint.checkpoint.index)
            .context(CTX)
    }

    pub async fn fetch_checkpoint(
        &self,
        validators: &Vec<H256>,
        threshold: usize,
        message: &HyperlaneMessage,
    ) -> Result<Option<MultisigSignedCheckpoint>> {
        const CTX: &str = "When fetching checkpoint signatures";
        let highest_known_nonce = self.prover_sync.read().await.count() - 1;
        let checkpoint_syncer = self
            .build_checkpoint_syncer(&validators)
            .await
            .context(CTX)?;
        checkpoint_syncer
            .fetch_checkpoint_in_range(
                &validators,
                threshold.into(),
                message.nonce,
                highest_known_nonce,
            )
            .await.context(CTX)
    }

    pub async fn build_routing_ism(
        &self,
        address: H256,
    ) -> Result<Box<dyn RoutingIsm>> {
        self
            .chain_setup
            .build_routing_ism(address, &self.metrics)
            .await
    }

    pub async fn build_multisig_ism(
        &self,
        address: H256,
    ) -> Result<Box<dyn MultisigIsm>> {
        self
            .chain_setup
            .build_multisig_ism(address, &self.metrics)
            .await
    }

    pub async fn build_checkpoint_syncer(
        &self,
        validators: &[H256],
    ) -> eyre::Result<MultisigCheckpointSyncer> {
        let storage_locations = self
            .validator_announce
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
                warn!(
                    ?validator,
                    ?validator_storage_locations,
                    "No valid checkpoint syncer configs for validator"
                );
            }
        }
        Ok(MultisigCheckpointSyncer::new(checkpoint_syncers))
    }
}
