use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule, Metadata, ModuleType,
    RawHyperlaneMessage, H256, U256,
};
use hyperlane_sealevel_composite_ism::accounts::{derive_domain_pda, CompositeIsmAccount, IsmNode};
use hyperlane_sealevel_composite_ism::instruction::verify_metadata_spec_instruction;
pub use hyperlane_sealevel_interchain_security_module_interface::MetadataSpec;
use hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS;
use serializable_account_meta::SimulationReturnData;
use solana_sdk::pubkey::Pubkey;
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

    /// Simulates `VerifyMetadataSpec` and returns the resolved [`MetadataSpec`].
    ///
    /// Uses a two-pass approach: the first simulation is tried with just the domain PDA
    /// (sufficient for `Routing` nodes and `FallbackRouting` when a domain ISM is configured).
    /// If that returns no data — which happens when a `FallbackRouting` node needs to fall
    /// back to the Mailbox's default ISM — the inbox PDA and fallback ISM storage PDA are
    /// fetched from chain and a second simulation is run with the full account list.
    pub async fn get_metadata_spec(&self, message: &HyperlaneMessage) -> ChainResult<MetadataSpec> {
        let message_bytes = RawHyperlaneMessage::from(message).to_vec();
        let (domain_pda, _) = derive_domain_pda(&self.program_id, message.origin);
        let payer = self
            .payer
            .as_ref()
            .map(|p| p.pubkey())
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        // Pass 1: try with just the domain PDA.
        let instruction = verify_metadata_spec_instruction(
            self.program_id,
            message_bytes.clone(),
            vec![domain_pda],
        )
        .map_err(ChainCommunicationError::from_other)?;

        // FallbackRouting fails the simulation when the fallback ISM's accounts are
        // missing; pass 2 will supply them. Any other simulation error propagates.
        // Ok(None) (program ran but set no return data) is always a bug.
        match self
            .provider
            .simulate_instruction::<SimulationReturnData<MetadataSpec>>(&payer, instruction)
            .await
        {
            Ok(Some(result)) => return Ok(result.return_data),
            Ok(None) => return Err(ChainCommunicationError::from_other_str(
                "VerifyMetadataSpec pass 1 returned no data — expected only for FallbackRouting",
            )),
            Err(_) => {} // fall through to pass 2
        }

        // Pass 1 simulation error — the root ISM is a FallbackRouting node whose
        // fallback path requires the fallback ISM's accounts.
        let fallback_accounts = self.resolve_fallback_routing_accounts(message).await?;
        let all_accounts = std::iter::once(domain_pda)
            .chain(fallback_accounts)
            .collect();

        let instruction2 =
            verify_metadata_spec_instruction(self.program_id, message_bytes, all_accounts)
                .map_err(ChainCommunicationError::from_other)?;

        self.provider
            .simulate_instruction::<SimulationReturnData<MetadataSpec>>(&payer, instruction2)
            .await?
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("No return data from VerifyMetadataSpec")
            })
            .map(|r| r.return_data)
    }

    /// Discovers the accounts needed for pass 2 of `VerifyMetadataSpec`.
    ///
    /// Reads the main VAM PDA to extract `FallbackRouting { fallback_ism }`, then
    /// simulates `VerifyAccountMetas` on the fallback ISM to learn which accounts
    /// it requires.  Those accounts (plus the fallback ISM program key itself) are
    /// returned so the composite ISM's on-chain CPI can supply them.
    async fn resolve_fallback_routing_accounts(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<Vec<Pubkey>> {
        let payer = self
            .payer
            .as_ref()
            .map(|p| p.pubkey())
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        let (vam_pda, _) =
            Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &self.program_id);
        let vam_account = self
            .provider
            .rpc_client()
            .get_account_with_finalized_commitment(vam_pda)
            .await?;
        let storage = CompositeIsmAccount::fetch_data(&mut &vam_account.data[..])
            .map_err(ChainCommunicationError::from_other)?
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("Composite ISM VAM PDA not initialized")
            })?;

        let fallback_ism = match storage.root {
            Some(IsmNode::FallbackRouting { fallback_ism }) => fallback_ism,
            _ => {
                return Err(ChainCommunicationError::from_other_str(
                    "Root ISM is not FallbackRouting; cannot resolve fallback accounts",
                ))
            }
        };

        let raw_msg = RawHyperlaneMessage::from(message).to_vec();
        let accounts = self
            .provider
            .get_ism_verify_account_metas(&payer, fallback_ism, vec![], raw_msg)
            .await?;

        // Include the fallback ISM program key so the on-chain CPI invoke can find it.
        Ok(accounts
            .into_iter()
            .map(|m| m.pubkey)
            .chain(std::iter::once(fallback_ism))
            .collect())
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
