use std::sync::Arc;

use tokio::sync::RwLock;
use tracing::{debug, info, instrument};

use hyperlane_base::{CachingMailbox, ChainSetup, CoreMetrics, MultisigCheckpointSyncer};
use hyperlane_core::HyperlaneMessage;
use hyperlane_core::{Mailbox, MultisigIsm};

use crate::merkle_tree_builder::MerkleTreeBuilder;

#[derive(Debug, Clone)]
pub struct MetadataBuilder {
    metrics: Arc<CoreMetrics>,
    chain_setup: ChainSetup,
    checkpoint_syncer: MultisigCheckpointSyncer,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
}

impl MetadataBuilder {
    pub fn new(
        metrics: Arc<CoreMetrics>,
        chain_setup: ChainSetup,
        checkpoint_syncer: MultisigCheckpointSyncer,
        prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    ) -> Self {
        MetadataBuilder {
            metrics,
            chain_setup,
            checkpoint_syncer,
            prover_sync,
        }
    }

    #[instrument(err, skip(mailbox), fields(msg_id=format!("{:x}", message.id())))]
    pub async fn fetch_metadata(
        &self,
        message: &HyperlaneMessage,
        mailbox: CachingMailbox,
    ) -> eyre::Result<Option<Vec<u8>>> {
        let ism_address = mailbox.recipient_ism(message.recipient).await?.to_string();
        let multisig_ism = self
            .chain_setup
            .build_multisig_ism(&ism_address, &self.metrics)
            .await?;

        let (validators, threshold) = multisig_ism.validators_and_threshold(message).await?;
        let highest_known_nonce = self.prover_sync.read().await.count() - 1;
        if let Some(checkpoint) = self
            .checkpoint_syncer
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
}
