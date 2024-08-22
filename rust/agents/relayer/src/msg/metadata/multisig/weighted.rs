use super::base::MultisigIsmMetadataBuilder;

use crate::msg::metadata::{
    multisig::{
        MerkleRootMultisigMetadataBuilder, MessageIdMultisigMetadataBuilder, MetadataToken,
        MultisigMetadata,
    },
    MessageMetadataBuilder,
};
use async_trait::async_trait;
use derive_more::AsRef;
use eyre::{Context, Result};
use hyperlane_base::MultisigCheckpointSyncer;
use hyperlane_core::{HyperlaneMessage, H256};

#[async_trait]
pub trait WeightedMultisigIsmMetadataBuilder: MultisigIsmMetadataBuilder {
    async fn ism_validator_requirements(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<(Vec<(H256, u64)>, u64)> {
        const CTX: &str = "When fetching WeightedMultisigIsm metadata";
        let multisig_ism = self
            .as_ref()
            .build_weighted_multisig_ism(ism_address)
            .await
            .context(CTX)?;

        let (validators, threshold) = multisig_ism
            .validators_and_threshold_weight(message)
            .await
            .context(CTX)?;

        Ok((validators, threshold as u64))
    }
}

#[derive(Debug, Clone, AsRef)]
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

#[derive(Debug, Clone, AsRef)]
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
