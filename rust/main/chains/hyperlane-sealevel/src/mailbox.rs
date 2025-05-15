// Silence a clippy bug https://github.com/rust-lang/rust-clippy/issues/12281
#![allow(clippy::blocks_in_conditions)]

use std::{collections::HashMap, str::FromStr as _, sync::Arc};

use async_trait::async_trait;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use hyperlane_sealevel_mailbox::{
    accounts::{Inbox, InboxAccount},
    instruction::InboxProcess,
    mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds, mailbox_process_authority_pda_seeds,
    mailbox_processed_message_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use lazy_static::lazy_static;
use serializable_account_meta::SimulationReturnData;
use solana_program::pubkey;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signer::Signer as _,
};
use tracing::{debug, instrument, warn};

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Encode as _, FixedPointNumber,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
    Mailbox, MerkleTreeHook, ReorgPeriod, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::priority_fee::PriorityFeeOracle;
use crate::tx_submitter::TransactionSubmitter;
use crate::utils::sanitize_dynamic_accounts;
use crate::{ConnectionConf, SealevelKeypair, SealevelProvider, SealevelProviderForSubmitter};

const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
const SPL_NOOP: &str = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";

// Earlier versions of collateral warp routes were deployed off a version where the mint
// was requested as a writeable account for handle instruction. This is not necessary,
// and generally requires a higher priority fee to be paid.
// This is a HashMap of of (collateral warp route recipient -> mint address) that is
// used to force the mint address to be readonly.
lazy_static! {
    static ref RECIPIENT_FORCED_READONLY_ACCOUNTS: HashMap<Pubkey, Pubkey> = HashMap::from([
        // EZSOL
        (pubkey!("b5pMgizA9vrGRt3hVqnU7vUVGBQUnLpwPzcJhG1ucyQ"), pubkey!("ezSoL6fY1PVdJcJsUpe5CM3xkfmy3zoVCABybm5WtiC")),
        // ORCA
        (pubkey!("8acihSm2QTGswniKgdgr4JBvJihZ1cakfvbqWCPBLoSp"), pubkey!("orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE")),
        // USDC
        (pubkey!("3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm"), pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")),
        // USDT
        (pubkey!("Bk79wMjvpPCh5iQcCEjPWFcG1V2TfgdwaBsWBEYFYSNU"), pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")),
        // WIF
        (pubkey!("CuQmsT4eSF4dYiiGUGYYQxJ7c58pUAD5ADE3BbFGzQKx"), pubkey!("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm")),
    ]);
}

/// A reference to a Mailbox contract on some Sealevel chain
pub struct SealevelMailbox {
    pub(crate) program_id: Pubkey,
    inbox: (Pubkey, u8),
    pub(crate) outbox: (Pubkey, u8),
    pub(crate) provider: Arc<SealevelProvider>,
    payer: Option<SealevelKeypair>,
    priority_fee_oracle: Box<dyn PriorityFeeOracle>,
    tx_submitter: Box<dyn TransactionSubmitter>,
}

impl SealevelMailbox {
    /// Create a new sealevel mailbox
    pub fn new(
        provider: Arc<SealevelProvider>,
        tx_submitter: Box<dyn TransactionSubmitter>,
        conf: &ConnectionConf,
        locator: &ContractLocator,
        payer: Option<SealevelKeypair>,
    ) -> ChainResult<Self> {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        let domain = locator.domain.id();
        let inbox = Pubkey::find_program_address(mailbox_inbox_pda_seeds!(), &program_id);
        let outbox = Pubkey::find_program_address(mailbox_outbox_pda_seeds!(), &program_id);

        debug!(
            "domain={}\nmailbox={}\ninbox=({}, {})\noutbox=({}, {})",
            domain, program_id, inbox.0, inbox.1, outbox.0, outbox.1,
        );

        Ok(SealevelMailbox {
            program_id,
            inbox,
            outbox,
            payer,
            priority_fee_oracle: conf.priority_fee_oracle.create_oracle(),
            tx_submitter,
            provider,
        })
    }

    /// Get the Inbox account pubkey and bump seed.
    pub fn inbox(&self) -> (Pubkey, u8) {
        self.inbox
    }

    /// Get the Outbox account pubkey and bump seed.
    pub fn outbox(&self) -> (Pubkey, u8) {
        self.outbox
    }

    /// Get the sealevel provider client.
    pub fn get_provider(&self) -> &SealevelProvider {
        &self.provider
    }

    /// Simulates an instruction, and attempts to deserialize it into a T.
    /// If no return data at all was returned, returns Ok(None).
    /// If some return data was returned but deserialization was unsuccessful,
    /// an Err is returned.
    pub async fn simulate_instruction<T: BorshDeserialize + BorshSerialize>(
        &self,
        instruction: Instruction,
    ) -> ChainResult<Option<T>> {
        let payer = self
            .payer
            .as_ref()
            .map(|p| p.pubkey())
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        self.provider
            .simulate_instruction(&payer, instruction)
            .await
    }

    /// Simulates an Instruction that will return a list of AccountMetas.
    pub async fn get_account_metas(
        &self,
        instruction: Instruction,
    ) -> ChainResult<Vec<AccountMeta>> {
        let payer = self
            .payer
            .as_ref()
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;
        self.provider.get_account_metas(payer, instruction).await
    }

    /// Gets the recipient ISM given a recipient program id and the ISM getter account metas.
    pub async fn get_recipient_ism(
        &self,
        recipient_program_id: Pubkey,
        ism_getter_account_metas: Vec<AccountMeta>,
    ) -> ChainResult<Pubkey> {
        let mut accounts = vec![
            // Inbox PDA
            AccountMeta::new_readonly(self.inbox.0, false),
            // The recipient program.
            AccountMeta::new_readonly(recipient_program_id, false),
        ];
        accounts.extend(ism_getter_account_metas);

        let instruction = Instruction::new_with_borsh(
            self.program_id,
            &hyperlane_sealevel_mailbox::instruction::Instruction::InboxGetRecipientIsm(
                recipient_program_id,
            ),
            accounts,
        );
        let ism = self
            .simulate_instruction::<SimulationReturnData<Pubkey>>(instruction)
            .await?
            .ok_or(ChainCommunicationError::from_other_str(
                "No return data from InboxGetRecipientIsm instruction",
            ))?
            .return_data;
        Ok(ism)
    }

    /// Gets the account metas required for the recipient's
    /// `MessageRecipientInstruction::InterchainSecurityModule` instruction.
    pub async fn get_ism_getter_account_metas(
        &self,
        recipient_program_id: Pubkey,
    ) -> ChainResult<Vec<AccountMeta>> {
        let instruction =
            hyperlane_sealevel_message_recipient_interface::MessageRecipientInstruction::InterchainSecurityModuleAccountMetas;
        self.get_non_signer_account_metas_with_instruction_bytes(
            recipient_program_id,
            &instruction
                .encode()
                .map_err(ChainCommunicationError::from_other)?,
                hyperlane_sealevel_message_recipient_interface::INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS,
        ).await
    }

    /// Gets the account metas required for the ISM's `Verify` instruction.
    pub async fn get_ism_verify_account_metas(
        &self,
        ism: Pubkey,
        metadata: Vec<u8>,
        message: Vec<u8>,
    ) -> ChainResult<Vec<AccountMeta>> {
        let instruction =
            InterchainSecurityModuleInstruction::VerifyAccountMetas(VerifyInstruction {
                metadata,
                message,
            });
        self.get_non_signer_account_metas_with_instruction_bytes(
            ism,
            &instruction
                .encode()
                .map_err(ChainCommunicationError::from_other)?,
            hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS,
        )
        .await
    }

    /// Gets the account metas required for the recipient's `MessageRecipientInstruction::Handle` instruction.
    pub async fn get_handle_account_metas(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<Vec<AccountMeta>> {
        let recipient_program_id = Pubkey::new_from_array(message.recipient.into());
        let instruction = MessageRecipientInstruction::HandleAccountMetas(HandleInstruction {
            sender: message.sender,
            origin: message.origin,
            message: message.body.clone(),
        });

        let mut account_metas = self
            .get_non_signer_account_metas_with_instruction_bytes(
                recipient_program_id,
                &instruction
                    .encode()
                    .map_err(ChainCommunicationError::from_other)?,
                hyperlane_sealevel_message_recipient_interface::HANDLE_ACCOUNT_METAS_PDA_SEEDS,
            )
            .await?;

        if let Some(forced_readonly_account) =
            RECIPIENT_FORCED_READONLY_ACCOUNTS.get(&recipient_program_id)
        {
            account_metas
                .iter_mut()
                .filter(|account_meta| account_meta.pubkey == *forced_readonly_account)
                .for_each(|account_meta| account_meta.is_writable = false);
        }

        Ok(account_metas)
    }

    async fn get_non_signer_account_metas_with_instruction_bytes(
        &self,
        program_id: Pubkey,
        instruction_data: &[u8],
        account_metas_pda_seeds: &[&[u8]],
    ) -> ChainResult<Vec<AccountMeta>> {
        let (account_metas_pda_key, _) =
            Pubkey::find_program_address(account_metas_pda_seeds, &program_id);
        let instruction = Instruction::new_with_bytes(
            program_id,
            instruction_data,
            vec![AccountMeta::new(account_metas_pda_key, false)],
        );

        let account_metas = self.get_account_metas(instruction).await?;

        // Ensure dynamically provided account metas are safe to prevent theft from the payer.
        sanitize_dynamic_accounts(account_metas, &self.get_payer()?.pubkey())
    }

    async fn get_process_instruction(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Instruction> {
        let recipient: Pubkey = message.recipient.0.into();
        let mut encoded_message = vec![];
        message.write_to(&mut encoded_message).unwrap();

        let payer = self.get_payer()?;

        let (process_authority_key, _process_authority_bump) = Pubkey::try_find_program_address(
            mailbox_process_authority_pda_seeds!(&recipient),
            &self.program_id,
        )
        .ok_or_else(|| {
            ChainCommunicationError::from_other_str(
                "Could not find program address for process authority",
            )
        })?;
        let (processed_message_account_key, _processed_message_account_bump) =
            Pubkey::try_find_program_address(
                mailbox_processed_message_pda_seeds!(message.id()),
                &self.program_id,
            )
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str(
                    "Could not find program address for processed message account",
                )
            })?;

        // Get the account metas required for the recipient.InterchainSecurityModule instruction.
        let ism_getter_account_metas = self.get_ism_getter_account_metas(recipient).await?;

        // Get the recipient ISM.
        let ism = self
            .get_recipient_ism(recipient, ism_getter_account_metas.clone())
            .await?;

        let ixn =
            hyperlane_sealevel_mailbox::instruction::Instruction::InboxProcess(InboxProcess {
                metadata: metadata.to_vec(),
                message: encoded_message.clone(),
            });
        let ixn_data = ixn
            .into_instruction_data()
            .map_err(ChainCommunicationError::from_other)?;

        // Craft the accounts for the transaction.
        let mut accounts: Vec<AccountMeta> = vec![
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new_readonly(Pubkey::from_str(SYSTEM_PROGRAM).unwrap(), false),
            AccountMeta::new(self.inbox.0, false),
            AccountMeta::new_readonly(process_authority_key, false),
            AccountMeta::new(processed_message_account_key, false),
        ];
        accounts.extend(ism_getter_account_metas);
        accounts.extend([
            AccountMeta::new_readonly(Pubkey::from_str(SPL_NOOP).unwrap(), false),
            AccountMeta::new_readonly(ism, false),
        ]);

        // Get the account metas required for the ISM.Verify instruction.
        let ism_verify_account_metas = self
            .get_ism_verify_account_metas(ism, metadata.into(), encoded_message)
            .await?;
        accounts.extend(ism_verify_account_metas);

        // The recipient.
        accounts.extend([AccountMeta::new_readonly(recipient, false)]);

        // Get account metas required for the Handle instruction
        let handle_account_metas = self.get_handle_account_metas(message).await?;
        accounts.extend(handle_account_metas);

        let process_instruction = Instruction {
            program_id: self.program_id,
            data: ixn_data,
            accounts,
        };

        Ok(process_instruction)
    }

    /// Get inbox account
    pub async fn get_inbox(&self) -> ChainResult<Box<Inbox>> {
        let account = self
            .provider
            .rpc_client()
            .get_account_with_finalized_commitment(self.inbox.0)
            .await?;
        let inbox = InboxAccount::fetch(&mut account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        Ok(inbox)
    }

    fn get_payer(&self) -> ChainResult<&SealevelKeypair> {
        self.payer
            .as_ref()
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)
    }
}

impl HyperlaneContract for SealevelMailbox {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.provider()
    }
}

impl std::fmt::Debug for SealevelMailbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self as &dyn HyperlaneContract)
    }
}

// TODO refactor the sealevel client into a lib and bin, pull in and use the lib here rather than
// duplicating.
#[async_trait]
impl Mailbox for SealevelMailbox {
    #[instrument(err, ret, skip(self))]
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        <Self as MerkleTreeHook>::count(self, reorg_period).await
    }

    #[instrument(err, ret, skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let (processed_message_account_key, _processed_message_account_bump) =
            Pubkey::find_program_address(
                mailbox_processed_message_pda_seeds!(id),
                &self.program_id,
            );

        let account = self
            .provider
            .rpc_client()
            .get_account_option_with_finalized_commitment(processed_message_account_key)
            .await?;

        Ok(account.is_some())
    }

    #[instrument(err, ret, skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        let inbox = self.get_inbox().await?;
        Ok(inbox.default_ism.to_bytes().into())
    }

    #[instrument(err, ret, skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let recipient_program_id = Pubkey::new_from_array(recipient.0);

        // Get the account metas required for the recipient.InterchainSecurityModule instruction.
        let ism_getter_account_metas = self
            .get_ism_getter_account_metas(recipient_program_id)
            .await?;

        // Get the ISM to use.
        let ism_pubkey = self
            .get_recipient_ism(recipient_program_id, ism_getter_account_metas)
            .await?;

        Ok(ism_pubkey.to_bytes().into())
    }

    #[instrument(err, ret, skip(self))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        // "processed" level commitment does not guarantee finality.
        // roughly 5% of blocks end up on a dropped fork.
        // However we don't want this function to be a bottleneck and there already
        // is retry logic in the agents.
        let commitment = CommitmentConfig::processed();

        let process_instruction = self.get_process_instruction(message, metadata).await?;

        let payer = self.get_payer()?;
        let tx = self
            .provider
            .build_estimated_tx_for_instruction(
                process_instruction,
                payer,
                &*self.tx_submitter,
                &*self.priority_fee_oracle,
            )
            .await?;

        tracing::info!(?tx, "Created sealevel transaction to process message");

        let signature = self.tx_submitter.send_transaction(&tx, true).await?;
        tracing::info!(?tx, ?signature, "Sealevel transaction sent");

        let send_instant = std::time::Instant::now();

        // Wait for the transaction to be confirmed.
        self.tx_submitter
            .wait_for_transaction_confirmation(&tx)
            .await?;

        // We expect time_to_confirm to fluctuate depending on the commitment level when submitting the
        // tx, but still use it as a proxy for tx latency to help debug.
        tracing::info!(?tx, ?signature, time_to_confirm=?send_instant.elapsed(), "Sealevel transaction confirmed");

        // TODO: not sure if this actually checks if the transaction was executed / reverted?
        // Confirm the transaction.
        let executed = self
            .tx_submitter
            .confirm_transaction(signature, commitment)
            .await
            .map_err(|err| warn!("Failed to confirm inbox process transaction: {}", err))
            .unwrap_or(false);
        let txid = signature.into();

        Ok(TxOutcome {
            transaction_id: txid,
            executed,
            // TODO use correct data upon integrating IGP support
            gas_price: U256::zero().try_into()?,
            gas_used: U256::zero(),
        })
    }

    #[instrument(err, ret, skip(self))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        // Getting a process instruction in Sealevel is a pretty expensive operation
        // that involves some view calls. Consider reusing the instruction with subsequent
        // calls to `process` to avoid this cost.
        let process_instruction = self.get_process_instruction(message, metadata).await?;

        let payer = self.get_payer()?;
        // The returned costs are unused at the moment - we simply want to perform a simulation to
        // determine if the message will revert or not.
        let _ = self
            .provider
            .get_estimated_costs_for_instruction(
                process_instruction,
                payer,
                &*self.tx_submitter,
                &*self.priority_fee_oracle,
            )
            .await?;

        // TODO use correct data upon integrating IGP support.
        // NOTE: providing a real gas limit here will result in accurately enforcing
        // gas payments. Be careful rolling this out to not impact existing contracts
        // that may not be paying for super accurate gas amounts.
        Ok(TxCostEstimate {
            gas_limit: U256::zero(),
            gas_price: FixedPointNumber::zero(),
            l2_gas_limit: None,
        })
    }

    async fn process_calldata(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        let process_instruction = self.get_process_instruction(message, metadata).await?;
        serde_json::to_vec(&process_instruction).map_err(Into::into)
    }

    fn delivered_calldata(&self, _message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        Ok(None)
    }
}
