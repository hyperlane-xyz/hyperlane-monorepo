use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, MultisigIsm, RawHyperlaneMessage, H256,
};
use hyperlane_sealevel_multisig_ism_message_id::instruction::ValidatorsAndThreshold;
use serializable_account_meta::SimulationReturnData;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signer::Signer,
};

use crate::{SealevelKeypair, SealevelProvider};

use multisig_ism::interface::{
    MultisigIsmInstruction, VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS,
};

/// A reference to a MultisigIsm contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelMultisigIsm {
    payer: Option<SealevelKeypair>,
    program_id: Pubkey,
    domain: HyperlaneDomain,
    provider: Arc<SealevelProvider>,
}

impl SealevelMultisigIsm {
    /// Create a new Sealevel MultisigIsm.
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
}

impl HyperlaneContract for SealevelMultisigIsm {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl MultisigIsm for SealevelMultisigIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let message_bytes = RawHyperlaneMessage::from(message).to_vec();

        let account_metas = self
            .get_validators_and_threshold_account_metas(message_bytes.clone())
            .await?;

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &MultisigIsmInstruction::ValidatorsAndThreshold(message_bytes)
                .encode()
                .map_err(ChainCommunicationError::from_other)?[..],
            account_metas,
        );

        let payer = self
            .payer
            .as_ref()
            .map(|p| p.pubkey())
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;
        let validators_and_threshold = self
            .provider
            .simulate_instruction::<SimulationReturnData<ValidatorsAndThreshold>>(
                &payer,
                instruction,
            )
            .await?
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str(
                    "No return data was returned from the multisig ism",
                )
            })?
            .return_data;

        let validators = validators_and_threshold
            .validators
            .into_iter()
            .map(|validator| validator.into())
            .collect();

        Ok((validators, validators_and_threshold.threshold))
    }
}

impl SealevelMultisigIsm {
    async fn get_validators_and_threshold_account_metas(
        &self,
        message_bytes: Vec<u8>,
    ) -> ChainResult<Vec<AccountMeta>> {
        let (account_metas_pda_key, _account_metas_pda_bump) = Pubkey::try_find_program_address(
            VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS,
            &self.program_id,
        )
        .ok_or_else(|| {
            ChainCommunicationError::from_other_str(
                "Could not find program address for domain data",
            )
        })?;

        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas(message_bytes)
                .encode()
                .map_err(ChainCommunicationError::from_other)?[..],
            vec![AccountMeta::new_readonly(account_metas_pda_key, false)],
        );

        let payer = self
            .payer
            .as_ref()
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;
        self.provider.get_account_metas(payer, instruction).await
    }
}
