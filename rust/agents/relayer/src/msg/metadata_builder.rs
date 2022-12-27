use std::sync::Arc;

use hyperlane_base::{CachingMailbox, ChainSetup, CoreMetrics, MultisigCheckpointSyncer};
use hyperlane_core::{HyperlaneMessage, Signers};
use hyperlane_core::{Mailbox, MultisigIsm, H256};
use tokio::sync::RwLock;
use tracing::{info, instrument};

use crate::merkle_tree_builder::MerkleTreeBuilder;

#[derive(Debug, Clone)]
pub struct MetadataBuilder {
    metrics: Arc<CoreMetrics>,
    signer: Option<Signers>,
    chain_setup: ChainSetup,
    checkpoint_syncer: MultisigCheckpointSyncer,
    prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
}

impl MetadataBuilder {
    pub fn new(
        metrics: Arc<CoreMetrics>,
        signer: Option<Signers>,
        chain_setup: ChainSetup,
        checkpoint_syncer: MultisigCheckpointSyncer,
        prover_sync: Arc<RwLock<MerkleTreeBuilder>>,
    ) -> Self {
        MetadataBuilder {
            metrics,
            signer,
            chain_setup,
            checkpoint_syncer,
            prover_sync,
        }
    }

    #[instrument(err, skip_all, fields(msg_nonce=message.nonce))]
    pub async fn fetch_metadata(
        &self,
        message: HyperlaneMessage,
        mailbox: CachingMailbox,
    ) -> eyre::Result<Vec<u8>> {
        let ism_address = mailbox.recipient_ism(message.recipient).await?;
        let multisig_ism = self.build_multisig_ism(ism_address).await?;
        let validators_and_threshold = multisig_ism
            .validators_and_threshold(message.clone())
            .await?;
        let validators = validators_and_threshold.0;
        if let Some(checkpoint) = self
            .checkpoint_syncer
            .fetch_checkpoint_in_range(
                validators.clone(),
                validators_and_threshold.1.into(),
                self.prover_sync.read().await.count() - 1,
                message.nonce,
            )
            .await?
        {
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
            assert_eq!(checkpoint.checkpoint.root, proof.root());
            let metadata = multisig_ism.format_metadata(
                validators.clone(),
                validators_and_threshold.1,
                &checkpoint,
                proof,
            );
            Ok(metadata)
        } else {
            // TODO: Figure out how to do proper error reporting. Should probably have the checkpoint syncer return errors rather than an option
            Err(eyre::eyre!("Checkpoint not found!"))
        }
    }

    async fn build_multisig_ism(&self, address: H256) -> eyre::Result<Box<dyn MultisigIsm>> {
        self.chain_setup
            .build_multisig_ism(self.signer.clone(), &self.metrics, address)
            .await
    }
}
