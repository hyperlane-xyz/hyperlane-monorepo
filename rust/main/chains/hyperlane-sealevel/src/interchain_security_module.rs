use std::sync::Arc;

use async_trait::async_trait;
use num_traits::cast::FromPrimitive;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signer::Signer,
};
use tracing::warn;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule, Metadata, ModuleType, H256, U256,
};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
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
        let (vam_pda, _) =
            Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &self.program_id);
        let type_ixn_data = InterchainSecurityModuleInstruction::Type
            .encode()
            .map_err(ChainCommunicationError::from_other)?;

        let pubkey = self
            .payer
            .as_ref()
            .map(|p| p.pubkey())
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        // Preferred call: pass the VAM PDA so ISMs that read config from it
        // (e.g. composite ISM) can resolve their type.  The interface contract
        // says ISMs SHOULD ignore unrecognised accounts, so well-behaved ISMs
        // accept this form.
        let with_vam_pda = Instruction::new_with_bytes(
            self.program_id,
            &type_ixn_data,
            vec![AccountMeta::new_readonly(vam_pda, false)],
        );
        let module = match self
            .provider
            .simulate_instruction::<SimulationReturnData<u32>>(&pubkey, with_vam_pda)
            .await
        {
            Ok(Some(result)) => result.return_data,
            // Fallback for ISMs that strictly reject unexpected accounts in
            // their Type handler (e.g. a third-party ISM that checks
            // accounts.is_empty()).  Retry with no accounts so we still get a
            // valid type rather than silently treating the ISM as Unused.
            Err(_) => {
                let no_accounts =
                    Instruction::new_with_bytes(self.program_id, &type_ixn_data, vec![]);
                self.provider
                    .simulate_instruction::<SimulationReturnData<u32>>(&pubkey, no_accounts)
                    .await?
                    .ok_or_else(|| {
                        ChainCommunicationError::from_other_str(
                            "No return data was returned from the ISM",
                        )
                    })?
                    .return_data
            }
            Ok(None) => {
                return Err(ChainCommunicationError::from_other_str(
                    "No return data was returned from the ISM",
                ))
            }
        };

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
        _metadata: &Metadata,
    ) -> ChainResult<Option<U256>> {
        // TODO: Implement this once we have aggregation ISM support in Sealevel
        Ok(Some(U256::zero()))
    }
}
