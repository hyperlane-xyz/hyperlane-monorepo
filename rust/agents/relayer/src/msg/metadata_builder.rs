use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;

use tokio::sync::RwLock;
use tracing::{debug, info, instrument};

use hyperlane_base::{
    CachingMailbox, ChainSetup, CheckpointSyncer, CheckpointSyncerConf, CoreMetrics,
    MultisigCheckpointSyncer,
};
use hyperlane_core::{
    HyperlaneChain, HyperlaneMessage, Mailbox, MultisigIsm, ValidatorAnnounce, H160, H256,
};
use std::str::FromStr;

use crate::merkle_tree_builder::MerkleTreeBuilder;

#[derive(Clone)]
pub struct MetadataBuilder {
    metrics: Arc<CoreMetrics>,
    chain_setup: ChainSetup,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    validator_announce: Arc<dyn ValidatorAnnounce>,
}

impl Debug for MetadataBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MetadataBuilder {{ chain_setup: {:?}, validator_announce: {:?} }}",
            self.chain_setup, self.validator_announce
        )
    }
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

    #[instrument(err, skip(mailbox))]
    pub async fn fetch_metadata(
        &self,
        message: &HyperlaneMessage,
        mailbox: CachingMailbox,
    ) -> eyre::Result<Option<Vec<u8>>> {
        // The Mailbox's `recipientIsm` function will revert if
        // the recipient is not a contract. This can pose issues with
        // our use of the RetryingProvider, which will continuously retry
        // the eth_call to the `recipientIsm` function.
        // As a workaround, we avoid the call entirely if the recipient is
        // not a contract.
        let provider = mailbox.provider();
        if !provider.is_contract(&message.recipient).await? {
            info!(
                recipient=?message.recipient,
                "Could not fetch metadata: Recipient is not a contract"
            );
            return Ok(None);
        }

        let ism_address = mailbox.recipient_ism(message.recipient).await?;
        let multisig_ism = self
            .chain_setup
            .build_multisig_ism(ism_address, &self.metrics)
            .await?;

        let (validators, threshold) = multisig_ism.validators_and_threshold(message).await?;
        let highest_known_nonce = self.prover_sync.read().await.count() - 1;
        let checkpoint_syncer = self.build_checkpoint_syncer(&validators).await?;
        let Some(checkpoint) = checkpoint_syncer
            .fetch_checkpoint_in_range(
                &validators,
                threshold.into(),
                message.nonce,
                highest_known_nonce,
            )
            .await?
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
            .get_proof(message.nonce, checkpoint.checkpoint.index)?;

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
                if let Ok(conf) = CheckpointSyncerConf::from_str(storage_location) {
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
