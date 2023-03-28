use std::collections::HashMap;
use std::fmt::Debug;
use std::str::FromStr;
use std::sync::Arc;
use async_trait::async_trait;
use num_derive::FromPrimitive;

use derive_new::new;
use eyre::Context;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

use hyperlane_base::{
    ChainSetup, CheckpointSyncer, CheckpointSyncerConf, CoreMetrics,
    MultisigCheckpointSyncer,
};
use hyperlane_core::{
    HyperlaneMessage, MultisigIsm, ValidatorAnnounce, H160, H256,
};

use crate::merkle_tree_builder::MerkleTreeBuilder;

#[derive(FromPrimitive)]

pub enum IsmTypes {
    Routing = 1,
    Aggregation = 2,
    LegacyMultisig = 3,
    Multisig = 4,
}

#[async_trait]
pub trait MetadataBuilder {
    /// The type of the ISM metadata is being built from
    // const TYPE: &'static IsmTypes;

    #[allow(clippy::async_yields_async)]
    async fn build(&self, 
        ism_address: H256,
        message: &HyperlaneMessage
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
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching metadata";
        let ism = self.chain_setup.build_ism(ism_address, &self.metrics).await.context(CTX)?;
        let module_type = ism.module_type().await.context(CTX)?;
        if let Some(metadata_builder) = match module_type.into() {
            IsmTypes::LegacyMultisig => Some(LegacyMultisigIsmMetadataBuilder::new(self.clone())),
            // Handle the rest of cases
            _ => None
        } {
            metadata_builder.build(ism_address, message).await.context(CTX)
        } else {
            // TODO: Return error
            Ok(None)
        }
    }
}

#[derive(Clone, new)]
pub struct LegacyMultisigIsmMetadataBuilder {
    base: BaseMetadataBuilder,
}


#[async_trait]
impl MetadataBuilder for LegacyMultisigIsmMetadataBuilder {
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching metadata";
        let multisig_ism = self
            .base.chain_setup
            .build_multisig_ism(ism_address, &self.base.metrics)
            .await
            .context(CTX)?;

        let (validators, threshold) = multisig_ism
            .validators_and_threshold(message)
            .await
            .context(CTX)?;
        let highest_known_nonce = self.base.prover_sync.read().await.count() - 1;
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
            .base.prover_sync
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
            .base.validator_announce
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
                if !self.base.allow_local_checkpoint_syncers
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
