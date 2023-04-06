use async_trait::async_trait;
use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use std::str::FromStr;
use std::{fmt::Debug, collections::HashMap};
use std::sync::Arc;

use derive_new::new;
use eyre::Context;
use tokio::sync::RwLock;
use tracing::{instrument, debug, warn};

use hyperlane_base::{
    ChainSetup, CoreMetrics, MultisigCheckpointSyncer, CheckpointSyncer, CheckpointSyncerConf
};
use hyperlane_core::{HyperlaneMessage, ValidatorAnnounce, H256, H160};

use crate::msg::metadata::{
    MultisigIsmMetadataBuilder, RoutingIsmMetadataBuilder};
use crate::{merkle_tree_builder::MerkleTreeBuilder};

#[derive(Debug, thiserror::Error)]
pub enum MetadataBuilderError {
    #[error("Unknown or invalid module type ({0})")]
    UnsupportedModuleType(u8),
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
    pub chain_setup: ChainSetup,
    pub prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    pub validator_announce: Arc<dyn ValidatorAnnounce>,
    pub allow_local_checkpoint_syncers: bool,
    pub metrics: Arc<CoreMetrics>,
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

        let metadata_builder: Box<dyn MetadataBuilder> = match supported_type {
            SupportedIsmTypes::Multisig => {
                Box::new(MultisigIsmMetadataBuilder::new(self.clone(), false))
            }
            SupportedIsmTypes::LegacyMultisig => {
                Box::new(MultisigIsmMetadataBuilder::new(self.clone(), true))
            }
            SupportedIsmTypes::Routing => {
                Box::new(RoutingIsmMetadataBuilder::new(self.clone()))
            }
        };
        metadata_builder
            .build(ism_address, message)
            .await
            .context(CTX)
    }
}

impl BaseMetadataBuilder {
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
