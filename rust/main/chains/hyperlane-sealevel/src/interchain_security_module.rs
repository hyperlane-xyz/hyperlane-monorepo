use std::sync::Arc;

use async_trait::async_trait;
use num_traits::cast::FromPrimitive;
use solana_sdk::{instruction::Instruction, pubkey::Pubkey, signer::Signer};
use tracing::warn;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule, ModuleType, H256, U256,
};
use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;
use serializable_account_meta::SimulationReturnData;

use crate::{SealevelKeypair, SealevelProvider};

/// A reference to an InterchainSecurityModule contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainSecurityModule {
    payer: Option<SealevelKeypair>,
    program_id: Pubkey,
    provider: Arc<SealevelProvider>,
}

impl SealevelInterchainSecurityModule {
    /// Create a new sealevel InterchainSecurityModule
    pub fn new(
        provider: Arc<SealevelProvider>,
        locator: ContractLocator,
        payer: Option<SealevelKeypair>,
    ) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            payer,
            program_id,
            provider,
        }
    }
}

impl HyperlaneContract for SealevelInterchainSecurityModule {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        self.provider.provider()
    }
}

#[async_trait]
impl InterchainSecurityModule for SealevelInterchainSecurityModule {
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &InterchainSecurityModuleInstruction::Type
                .encode()
                .map_err(ChainCommunicationError::from_other)?[..],
            vec![],
        );

        let pubkey = self
            .payer
            .as_ref()
            .map(|p| p.pubkey())
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;
        let module = self
            .provider
            .simulate_instruction::<SimulationReturnData<u32>>(&pubkey, instruction)
            .await?
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("No return data was returned from the ISM")
            })?
            .return_data;

        if let Some(module_type) = ModuleType::from_u32(module) {
            Ok(module_type)
        } else {
            warn!(%module, "Unknown module type");
            Ok(ModuleType::Unused)
        }
    }

    async fn dry_run_verify(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        // TODO: Implement this once we have aggregation ISM support in Sealevel
        Ok(Some(U256::zero()))
    }
}
