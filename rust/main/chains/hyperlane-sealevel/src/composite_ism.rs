use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule, Metadata, ModuleType,
    RawHyperlaneMessage, H256, U256,
};
use hyperlane_sealevel_composite_ism::accounts::derive_domain_pda;
use hyperlane_sealevel_composite_ism::instruction::get_metadata_spec_instruction;
pub use hyperlane_sealevel_composite_ism::metadata_spec::MetadataSpec;
use serializable_account_meta::SimulationReturnData;
use solana_sdk::signer::Signer;

use crate::{SealevelKeypair, SealevelProvider};

/// A reference to the composite ISM program on some Sealevel chain.
#[derive(Debug)]
pub struct SealevelCompositeIsm {
    payer: Option<SealevelKeypair>,
    program_id: solana_sdk::pubkey::Pubkey,
    domain: HyperlaneDomain,
    provider: Arc<SealevelProvider>,
}

impl SealevelCompositeIsm {
    /// Create a new SealevelCompositeIsm.
    pub fn new(
        provider: Arc<SealevelProvider>,
        locator: ContractLocator,
        payer: Option<SealevelKeypair>,
    ) -> Self {
        let program_id = solana_sdk::pubkey::Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            payer,
            program_id,
            domain: locator.domain.clone(),
            provider,
        }
    }

    /// Simulates `GetMetadataSpec` and returns the resolved [`MetadataSpec`].
    pub async fn get_metadata_spec(&self, message: &HyperlaneMessage) -> ChainResult<MetadataSpec> {
        let message_bytes = RawHyperlaneMessage::from(message).to_vec();

        // Derive the per-origin domain PDA in case the root ISM is a Routing node.
        // For non-Routing roots the extra account is ignored by the program.
        let (domain_pda, _) = derive_domain_pda(&self.program_id, message.origin);

        let instruction =
            get_metadata_spec_instruction(self.program_id, message_bytes, vec![domain_pda])
                .map_err(ChainCommunicationError::from_other)?;

        let payer = self
            .payer
            .as_ref()
            .map(|p| p.pubkey())
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        let spec = self
            .provider
            .simulate_instruction::<SimulationReturnData<MetadataSpec>>(&payer, instruction)
            .await?
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("No return data from GetMetadataSpec")
            })?
            .return_data;

        Ok(spec)
    }
}

impl HyperlaneContract for SealevelCompositeIsm {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelCompositeIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        self.provider.provider()
    }
}

#[async_trait]
impl InterchainSecurityModule for SealevelCompositeIsm {
    async fn module_type(&self) -> ChainResult<ModuleType> {
        Ok(ModuleType::Composite)
    }

    async fn dry_run_verify(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &Metadata,
    ) -> ChainResult<Option<U256>> {
        Ok(Some(U256::zero()))
    }
}
