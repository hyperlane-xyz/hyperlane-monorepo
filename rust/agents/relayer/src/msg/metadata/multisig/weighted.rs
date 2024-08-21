use super::base::MultisigIsmMetadataBuilder;
use async_trait::async_trait;
use eyre::{Context, Result};
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
            .build_multisig_ism(ism_address)
            .await
            .context(CTX)?;

        multisig_ism
            .validators_and_threshold(message)
            .await
            .context(CTX)
    }
}
