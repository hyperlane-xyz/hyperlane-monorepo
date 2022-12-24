use std::sync::Arc;

use hyperlane_base::{CachingMailbox, ChainSetup, CoreMetrics, MultisigCheckpointSyncer};
use hyperlane_core::{
    accumulator::merkle::Proof, HyperlaneMessage, Signers,
};
use hyperlane_core::{Mailbox, MultisigIsm, H256};
use tracing::{instrument, error};

#[derive(Debug, Clone)]
pub struct MetadataBuilder {
    metrics: Arc<CoreMetrics>,
    signer: Option<Signers>,
    chain_setup: ChainSetup,
    checkpoint_syncer: MultisigCheckpointSyncer,
}

impl MetadataBuilder {
    pub fn new(
        metrics: Arc<CoreMetrics>,
        signer: Option<Signers>,
        chain_setup: ChainSetup,
        checkpoint_syncer: MultisigCheckpointSyncer,
    ) -> Self {
        MetadataBuilder {
            metrics,
            signer,
            chain_setup,
            checkpoint_syncer
        }
    }

    #[instrument(err, skip_all, fields(msg_nonce=message.nonce, proof_index=proof.index))]
    pub async fn fetch_metadata(
        &self,
        message: HyperlaneMessage,
        mailbox: CachingMailbox,
        proof: Proof,
        proof_index: u32,
    ) -> eyre::Result<Vec<u8>> {
        let ism_address = mailbox.recipient_ism(message.recipient).await?;
        let multisig_ism = self.build_multisig_ism(ism_address).await?;
        let validators_and_threshold = multisig_ism.validators_and_threshold(message.clone()).await?;
        let validators = validators_and_threshold.0;
        // TODO: Actually should probably be looking for a specific proof index.
        // But this will have to do since eventually we will let the checkpoint dictate
        // the proof, not the other way around
        if let Some(checkpoint) = self
        .checkpoint_syncer
        .latest_checkpoint(
            validators.clone(),
            validators_and_threshold.1.into(),
            Some(message.nonce),
        )
        .await?
        {
            // TOOD: Check indices
            if checkpoint.checkpoint.root == proof.root() {
                let metadata = multisig_ism
                    .format_metadata(validators.clone(), &checkpoint, proof); 
                Ok(metadata)
            } else {
                error!(checkpoint_index=checkpoint.checkpoint.index, proof_index=proof_index, "Checkpoint/proof mismatch");
                // TODO: Figure out how to do proper error reporting
                Err(eyre::eyre!(format!("Checkpoint/proof mismatch!")))
            }
        } else {
            // TODO: Figure out how to do proper error reporting
            Err(eyre::eyre!("Checkpoint not found!"))
        }
    }

    async fn build_multisig_ism(&self, address: H256) -> eyre::Result<Box<dyn MultisigIsm>> {
        self.chain_setup
            .build_multisig_ism(self.signer.clone(), &self.metrics, address)
            .await
    }
}
