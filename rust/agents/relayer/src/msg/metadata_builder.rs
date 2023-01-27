use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;
use tracing::{debug, info, instrument};

use hyperlane_base::{
    CachingMailbox, ChainSetup, CheckpointSyncer, CheckpointSyncerConf, CoreMetrics,
    MultisigCheckpointSyncer,
};
use hyperlane_core::{HyperlaneMessage, Mailbox, MultisigIsm, ValidatorAnnounce, H160, H256};

use crate::merkle_tree_builder::MerkleTreeBuilder;

#[derive(Debug, Clone)]
pub struct MetadataBuilder {
    metrics: Arc<CoreMetrics>,
    chain_setup: ChainSetup,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    validator_announce: Arc<dyn ValidatorAnnounce>,
}

impl MetadataBuilder {
    pub fn new(
        chain_setup: ChainSetup,
        prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
        validator_announce: Arc<dyn ValidatorAnnounce>,
        metrics: Arc<CoreMetrics>,
    ) -> Self {
        MetadataBuilder {
            metrics,
            chain_setup,
            prover_sync,
            validator_announce,
        }
    }

    #[instrument(err, skip(mailbox), fields(msg_id=format!("{:x}", message.id())))]
    pub async fn fetch_metadata(
        &self,
        message: &HyperlaneMessage,
        mailbox: CachingMailbox,
    ) -> eyre::Result<Option<Vec<u8>>> {
        let ism_address = mailbox.recipient_ism(message.recipient).await?;
        let multisig_ism = self
            .chain_setup
            .build_multisig_ism(ism_address, &self.metrics)
            .await?;

        let (validators, threshold) = multisig_ism.validators_and_threshold(message).await?;
        let highest_known_nonce = self.prover_sync.read().await.count() - 1;
        let checkpoint_syncer = self.build_checkpoint_syncer(&validators).await?;
        if let Some(checkpoint) = checkpoint_syncer
            .fetch_checkpoint_in_range(
                &validators,
                threshold.into(),
                message.nonce,
                highest_known_nonce,
            )
            .await?
        {
            // At this point we have a signed checkpoint with a quorum of validator
            // signatures. But it may be a fraudulent checkpoint that doesn't
            // match the canonical root at the checkpoint's index.
            info!(
                checkpoint_index = checkpoint.checkpoint.index,
                signature_count = checkpoint.signatures.len(),
                "Found checkpoint with quorum"
            );

            let proof = self
                .prover_sync
                .read()
                .await
                .get_proof(message.nonce, checkpoint.checkpoint.index)?;

            if checkpoint.checkpoint.root == proof.root() {
                let metadata =
                    multisig_ism.format_metadata(&validators, threshold, &checkpoint, &proof);
                Ok(Some(metadata))
            } else {
                debug!(
                    checkpoint = format!("{}", checkpoint.checkpoint),
                    canonical_root = format!("{:x}", proof.root()),
                    "Signed checkpoint does not match canonical root"
                );
                Ok(None)
            }
        } else {
            debug!(
                validators = format!("{:?}", validators),
                threshold = threshold,
                highest_known_nonce = highest_known_nonce,
                "Unable to reach quorum"
            );
            Ok(None)
        }
    }

    async fn build_checkpoint_syncer(
        &self,
        validators: &[H256],
    ) -> eyre::Result<MultisigCheckpointSyncer> {
        let mut checkpoint_syncers: HashMap<H160, Arc<dyn CheckpointSyncer>> = HashMap::new();
        let storage_locations = self
            .validator_announce
            .get_announced_storage_locations(validators)
            .await?;
        // Only use the most recently announced location for now.
        for (i, validator_storage_locations) in storage_locations.iter().enumerate() {
            for storage_location in validator_storage_locations.iter().rev() {
                if let Some(conf) = CheckpointSyncerConf::from_storage_location(storage_location) {
                    if let Ok(checkpoint_syncer) = conf.build(None) {
                        checkpoint_syncers
                            .insert(H160::from(validators[i]), checkpoint_syncer.into());
                        break;
                    }
                }
            }
        }
        Ok(MultisigCheckpointSyncer::new(checkpoint_syncers))
    }
}
