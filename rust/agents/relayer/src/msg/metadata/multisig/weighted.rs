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
use hyperlane_base::{MultisigCheckpointSyncer, ValidatorWithWeight, Weight};
use hyperlane_core::{HyperlaneMessage, H256};

#[derive(Debug, Clone, Deref, new, AsRef)]
pub struct WeightedMerkleRootMultisigMetadataBuilder(MessageMetadataBuilder);

#[async_trait]
impl MultisigIsmMetadataBuilder for WeightedMerkleRootMultisigMetadataBuilder {
    async fn ism_validator_requirements(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<(Vec<ValidatorWithWeight>, Weight)> {
        const CTX: &str = "When fetching WeightedMultisigIsm metadata";
        let weighted_multisig_ism = self
            .as_ref()
            .build_weighted_multisig_ism(ism_address)
            .await
            .context(CTX)?;

        let (validators, threshold) = weighted_multisig_ism
            .validators_and_threshold_weight(message)
            .await
            .context(CTX)?;

        let validators: Vec<ValidatorWithWeight> = validators
            .into_iter()
            .map(|(validator, weight)| ValidatorWithWeight::new(validator, weight))
            .collect();

        Ok((validators, threshold))
    }

    fn token_layout(&self) -> Vec<MetadataToken> {
        MerkleRootMultisigMetadataBuilder::new(self.0.clone()).token_layout()
    }

    async fn fetch_metadata(
        &self,
        validators: &[ValidatorWithWeight],
        threshold_weight: Weight,
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
impl MultisigIsmMetadataBuilder for WeightedMessageIdMultisigMetadataBuilder {
    async fn ism_validator_requirements(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> Result<(Vec<ValidatorWithWeight>, Weight)> {
        const CTX: &str = "When fetching WeightedMultisigIsm metadata";
        let weighted_multisig_ism = self
            .as_ref()
            .build_weighted_multisig_ism(ism_address)
            .await
            .context(CTX)?;

        let (validators, threshold) = weighted_multisig_ism
            .validators_and_threshold_weight(message)
            .await
            .context(CTX)?;

        let validators: Vec<ValidatorWithWeight> = validators
            .into_iter()
            .map(|(validator, weight)| ValidatorWithWeight::new(validator, weight))
            .collect();

        Ok((validators, threshold))
    }

    fn token_layout(&self) -> Vec<MetadataToken> {
        MessageIdMultisigMetadataBuilder::new(self.0.clone()).token_layout()
    }

    async fn fetch_metadata(
        &self,
        validators: &[ValidatorWithWeight],
        threshold_weight: Weight,
        message: &HyperlaneMessage,
        checkpoint_syncer: &MultisigCheckpointSyncer,
    ) -> Result<Option<MultisigMetadata>> {
        MessageIdMultisigMetadataBuilder::new(self.0.clone())
            .fetch_metadata(validators, threshold_weight, message, checkpoint_syncer)
            .await
    }
}
