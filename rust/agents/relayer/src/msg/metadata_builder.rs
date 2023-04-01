use async_trait::async_trait;
use num_derive::FromPrimitive;
use num_traits::FromPrimitive;
use std::fmt::Debug;
use std::str::FromStr;
use std::sync::Arc;
use std::{collections::HashMap, ops::Deref};

use derive_new::new;
use eyre::Context;
use tokio::sync::RwLock;
use tracing::{debug, info, instrument, warn};

use hyperlane_base::{
    ChainSetup, CheckpointSyncer, CheckpointSyncerConf, CoreMetrics, MultisigCheckpointSyncer,
};
use hyperlane_core::{HyperlaneMessage, MultisigIsm, ValidatorAnnounce, H160, H256};

use crate::merkle_tree_builder::MerkleTreeBuilder;

#[derive(Debug, thiserror::Error)]
pub enum MetadataBuilderError {
    #[error("Unknown or invalid module type ({0})")]
    UnsupportedModuleType(u8),
}

#[derive(FromPrimitive)]
pub enum SupportedIsmTypes {
    // Routing = 1,
    // Aggregation = 2,
    LegacyMultisig = 3,
    // Multisig = 4,
}

#[async_trait]
pub trait MetadataBuilder {
    #[allow(clippy::async_yields_async)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>>;
}

#[derive(Clone, new)]
pub struct BaseMetadataBuilder {
    chain_setup: ChainSetup,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    validator_announce: Arc<dyn ValidatorAnnounce>,
    allow_local_checkpoint_syncers: bool,
    metrics: Arc<CoreMetrics>,
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

        let metadata_builder = match supported_type {
            SupportedIsmTypes::LegacyMultisig => {
                LegacyMultisigIsmMetadataBuilder::new(self.clone())
            }
        };
        metadata_builder
            .build(ism_address, message)
            .await
            .context(CTX)
    }
}

#[derive(Clone, Debug, new)]
pub struct LegacyMultisigIsmMetadataBuilder {
    base: BaseMetadataBuilder,
}

impl Deref for LegacyMultisigIsmMetadataBuilder {
    type Target = BaseMetadataBuilder;

    fn deref(&self) -> &Self::Target {
        &self.base
    }
}

#[async_trait]
impl MetadataBuilder for LegacyMultisigIsmMetadataBuilder {
    #[instrument(err)]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching LegacyMultisigIsm metadata";
        let multisig_ism = self
            .base
            .chain_setup
            .build_multisig_ism(ism_address, &self.metrics)
            .await
            .context(CTX)?;

        let (validators, threshold) = multisig_ism
            .validators_and_threshold(message)
            .await
            .context(CTX)?;
        let highest_known_nonce = self.prover_sync.read().await.count() - 1;
        let checkpoint_syncer = self
            .build_checkpoint_syncer(&validators)
            .await
            .context(CTX)?;
        let Some(checkpoint) = checkpoint_syncer
            .fetch_checkpoint_in_range(
                &validators,
                threshold.into(),
                message.nonce,
                highest_known_nonce,
            )
            .await.context(CTX)?
        else {
            info!(
                ?validators, threshold, highest_known_nonce,
                "Could not fetch metadata: Unable to reach quorum"
            );
            return Ok(None);
        };

        // At this point we have a signed checkpoint with a quorum of validator
        // signatures. But it may be a fraudulent checkpoint that doesn't
        // match the canonical root at the checkpoint's index.
        debug!(?checkpoint, "Found checkpoint with quorum");

        let proof = self
            .prover_sync
            .read()
            .await
            .get_proof(message.nonce, checkpoint.checkpoint.index)
            .context(CTX)?;

        if checkpoint.checkpoint.root == proof.root() {
            debug!(
                ?validators,
                threshold,
                ?checkpoint,
                ?proof,
                "Fetched metadata"
            );
            let metadata =
                multisig_ism.format_metadata(&validators, threshold, &checkpoint, &proof);
            Ok(Some(metadata))
        } else {
            info!(
                ?checkpoint,
                canonical_root = ?proof.root(),
                "Could not fetch metadata: Signed checkpoint does not match canonical root"
            );
            Ok(None)
        }
    }
}

impl LegacyMultisigIsmMetadataBuilder {
    async fn build_checkpoint_syncer(
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
