use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule, Metadata, ModuleType,
    RawHyperlaneMessage, H256, U256,
};
use hyperlane_sealevel_composite_ism::accounts::derive_domain_pda;
use hyperlane_sealevel_composite_ism::instruction::verify_metadata_spec_instruction;
pub use hyperlane_sealevel_interchain_security_module_interface::MetadataSpec;
use hyperlane_sealevel_interchain_security_module_interface::MetadataSpecResult;
use serializable_account_meta::SimulationReturnData;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signer::Signer;

use crate::{SealevelKeypair, SealevelProvider};

const MAX_SPEC_ITERATIONS: usize = 10;

/// A reference to the composite ISM program on some Sealevel chain.
#[derive(Debug)]
pub struct SealevelCompositeIsm {
    payer: Option<SealevelKeypair>,
    program_id: Pubkey,
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
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            payer,
            program_id,
            domain: locator.domain.clone(),
            provider,
        }
    }

    /// Simulates `VerifyMetadataSpec` in a fixpoint loop, growing the account
    /// list until the ISM returns a converged `MetadataSpec`.
    ///
    /// Each iteration the ISM returns either:
    /// - `spec: Some(s)` — done; or
    /// - `spec: None, accounts: [vam_pda, a, b, …]` — re-simulate with
    ///   `accounts[1..]` as the new extra-accounts list.
    pub async fn get_metadata_spec(&self, message: &HyperlaneMessage) -> ChainResult<MetadataSpec> {
        let message_bytes = RawHyperlaneMessage::from(message).to_vec();
        let payer = self
            .payer
            .as_ref()
            .map(|p| p.pubkey())
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        let (domain_pda_key, _) = derive_domain_pda(&self.program_id, message.origin);
        let mut extra_accounts: Vec<Pubkey> = vec![domain_pda_key];

        for _ in 0..MAX_SPEC_ITERATIONS {
            let instruction = verify_metadata_spec_instruction(
                self.program_id,
                message_bytes.clone(),
                extra_accounts.clone(),
            )
            .map_err(ChainCommunicationError::from_other)?;

            let result = self
                .provider
                .simulate_instruction::<SimulationReturnData<MetadataSpecResult>>(
                    &payer,
                    instruction,
                )
                .await?
                .ok_or_else(|| {
                    ChainCommunicationError::from_other_str("VerifyMetadataSpec returned no data")
                })?
                .return_data;

            if let Some(spec) = result.spec {
                return Ok(spec);
            }

            // result.accounts = [vam_pda, a, b, …]  (the complete desired list).
            // extra_accounts for the next simulation = everything after the VAM PDA.
            if result.accounts.is_empty() {
                return Err(ChainCommunicationError::from_other_str(
                    "VerifyMetadataSpec returned spec: None with empty accounts",
                ));
            }
            extra_accounts = result.accounts[1..].to_vec();
        }

        Err(ChainCommunicationError::from_other_str(
            "VerifyMetadataSpec fixpoint did not converge",
        ))
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
