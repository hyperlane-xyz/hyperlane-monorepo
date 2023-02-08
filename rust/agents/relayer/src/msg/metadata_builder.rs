use std::fmt::{Debug, Formatter};
use std::sync::Arc;

use tokio::sync::RwLock;
use tracing::{debug, info, instrument};

use hyperlane_base::{CachingMailbox, ChainSetup, CoreMetrics, MultisigCheckpointSyncer};
use hyperlane_core::{HyperlaneChain, HyperlaneMessage, Mailbox, MultisigIsm};

use crate::merkle_tree_builder::MerkleTreeBuilder;

#[derive(Clone)]
pub struct MetadataBuilder {
    metrics: Arc<CoreMetrics>,
    chain_setup: ChainSetup,
    checkpoint_syncer: MultisigCheckpointSyncer,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
}

impl Debug for MetadataBuilder {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MetadataBuilder {{ chain_setup: {:?}, checkpoint_syncer: {:?} }}",
            self.chain_setup, self.checkpoint_syncer
        )
    }
}

impl MetadataBuilder {
    pub fn new(
        chain_setup: ChainSetup,
        checkpoint_syncer: MultisigCheckpointSyncer,
        prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
        metrics: Arc<CoreMetrics>,
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
        // The Mailbox's `recipientIsm` function will revert if
        // the recipient is not a contract. This can pose issues with
        // our use of the RetryingProvider, which will continuously retry
        // the eth_call to the `recipientIsm` function.
        // As a workaround, we avoid the call entirely if the recipient is
        // not a contract.
        let provider = mailbox.provider();
        if !provider.is_contract(&message.recipient).await? {
            debug!(
                recipient=?message.recipient,
                "Recipient is not a contract, not fetching metadata"
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
