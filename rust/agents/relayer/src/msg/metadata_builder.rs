use std::sync::Arc;

use hyperlane_base::{CachingMailbox, ChainSetup, CoreMetrics};
use hyperlane_core::{
    accumulator::merkle::Proof, HyperlaneMessage, MultisigSignedCheckpoint, Signers,
};
use hyperlane_core::{Mailbox, MultisigIsm, H256};

#[derive(Debug, Clone)]
pub struct MetadataBuilder {
    metrics: Arc<CoreMetrics>,
    signer: Option<Signers>,
    chain_setup: ChainSetup,
}

impl MetadataBuilder {
    pub fn new(
        metrics: Arc<CoreMetrics>,
        signer: Option<Signers>,
        chain_setup: ChainSetup,
    ) -> Self {
        MetadataBuilder {
            metrics,
            signer,
            chain_setup,
        }
    }

    pub async fn fetch_metadata(
        &self,
        message: HyperlaneMessage,
        mailbox: CachingMailbox,
        checkpoint: MultisigSignedCheckpoint,
        proof: Proof,
    ) -> eyre::Result<Vec<u8>> {
        let ism_address = mailbox.recipient_ism(message.recipient).await?;
        let multisig_ism = self.build_multisig_ism(ism_address).await?;

        let metadata = multisig_ism
            .format_metadata(message.clone(), &checkpoint, proof)
            .await?;
        Ok(metadata)
    }

    async fn build_multisig_ism(&self, address: H256) -> eyre::Result<Box<dyn MultisigIsm>> {
        self.chain_setup
            .build_multisig_ism(self.signer.clone(), &self.metrics, address)
            .await
    }
}
