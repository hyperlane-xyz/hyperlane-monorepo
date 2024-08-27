use super::base::MultisigIsmMetadataBuilder;

use crate::msg::metadata::{
    multisig::{
        MerkleRootMultisigMetadataBuilder, MessageIdMultisigMetadataBuilder, MetadataToken,
        MultisigMetadata,
    },
    MessageMetadataBuilder,
};
use async_trait::async_trait;
use derive_more::{AsRef, Deref};
use derive_new::new;
use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{HyperlaneMessage, H256};
use tracing::{debug, info};

#[async_trait]
pub trait WeightedMultisigIsmMetadataBuilder: MultisigIsmMetadataBuilder {
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching MultisigIsm metadata";
        let weighted_multisig_ism = self
            .as_ref()
            .build_weighted_multisig_ism(ism_address)
            .await
            .context(CTX)?;

        let (weighted_validators, threshold_weight) = weighted_multisig_ism
            .validators_and_threshold_weight(message)
            .await
            .context(CTX)?;

        if weighted_validators.is_empty() {
            info!("Could not fetch metadata: No validator set found for ISM");
            return Ok(None);
        }

        let validators: Vec<H256> = weighted_validators
            .iter()
            .map(|(address, _)| *address)
            .collect();

        let checkpoint_syncer = self
            .as_ref()
            .build_checkpoint_syncer(&validators, self.as_ref().app_context.clone())
            .await
            .context(CTX)?;

        if let Some(metadata) = self
            .fetch_metadata(
                &weighted_validators,
                threshold_weight,
                message,
                &checkpoint_syncer,
            )
            .await
            .context(CTX)?
        {
            debug!(?message, ?metadata.checkpoint, "Found checkpoint with quorum");
            Ok(Some(self.format_metadata(metadata)?))
        } else {
            info!(
                ?message, ?weighted_validators, threshold_weight, ism=%weighted_multisig_ism.address(),
                "Could not fetch metadata: Unable to reach quorum"
            );
            Ok(None)
        }
    }
}

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct WeightedMerkleRootMultisigMetadataBuilder(MessageMetadataBuilder);

#[async_trait]
impl WeightedMultisigIsmMetadataBuilder for WeightedMerkleRootMultisigMetadataBuilder {}

#[async_trait]
impl MultisigIsmMetadataBuilder for WeightedMerkleRootMultisigMetadataBuilder {
    fn token_layout(&self) -> Vec<MetadataToken> {
        MerkleRootMultisigMetadataBuilder::new(self.0.clone()).token_layout()
    }

    async fn fetch_metadata(
        &self,
        validators: &[(H256, u64)],
        threshold_weight: u64,
        message: &HyperlaneMessage,
        checkpoint_syncer: &MultisigCheckpointSyncer,
    ) -> Result<Option<MultisigMetadata>> {
        MerkleRootMultisigMetadataBuilder::new(self.0.clone())
            .fetch_metadata(validators, threshold_weight, message, checkpoint_syncer)
            .await
    }
}

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct WeightedMessageIdMultisigMetadataBuilder(MessageMetadataBuilder);

#[async_trait]
impl WeightedMultisigIsmMetadataBuilder for WeightedMessageIdMultisigMetadataBuilder {}

#[async_trait]
impl MultisigIsmMetadataBuilder for WeightedMessageIdMultisigMetadataBuilder {
    fn token_layout(&self) -> Vec<MetadataToken> {
        MessageIdMultisigMetadataBuilder::new(self.0.clone()).token_layout()
    }

    async fn fetch_metadata(
        &self,
        validators: &[(H256, u64)],
        threshold_weight: u64,
        message: &HyperlaneMessage,
        checkpoint_syncer: &MultisigCheckpointSyncer,
    ) -> Result<Option<MultisigMetadata>> {
        MessageIdMultisigMetadataBuilder::new(self.0.clone())
            .fetch_metadata(validators, threshold_weight, message, checkpoint_syncer)
            .await
    }
}
