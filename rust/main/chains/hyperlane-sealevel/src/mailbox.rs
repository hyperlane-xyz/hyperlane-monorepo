// Silence a clippy bug https://github.com/rust-lang/rust-clippy/issues/12281
#![allow(clippy::blocks_in_conditions)]

use std::{collections::HashMap, ops::RangeInclusive, str::FromStr as _};

use async_trait::async_trait;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use hyperlane_sealevel_mailbox::{
    accounts::{
        DispatchedMessageAccount, Inbox, InboxAccount, ProcessedMessageAccount,
        DISPATCHED_MESSAGE_DISCRIMINATOR, PROCESSED_MESSAGE_DISCRIMINATOR,
    },
    instruction::InboxProcess,
    mailbox_dispatched_message_pda_seeds, mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds,
    mailbox_process_authority_pda_seeds, mailbox_processed_message_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use lazy_static::lazy_static;
use serializable_account_meta::SimulationReturnData;
use solana_program::pubkey;
use solana_sdk::{
    account::Account,
    clock::Slot,
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signer::{keypair::Keypair, Signer as _},
    transaction::Transaction,
};
use tracing::{debug, info, instrument, warn};

use hyperlane_core::{
    config::StrOrIntParseError, ChainCommunicationError, ChainResult, ContractLocator, Decode as _,
    Encode as _, FixedPointNumber, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, LogMeta, Mailbox, MerkleTreeHook,
    ReorgPeriod, SequenceAwareIndexer, TxCostEstimate, TxOutcome, H256, H512, U256,
};

use crate::log_meta_composer::{
    is_message_delivery_instruction, is_message_dispatch_instruction, LogMetaComposer,
};
use crate::tx_submitter::TransactionSubmitter;
use crate::{
    account::{search_accounts_by_discriminator, search_and_validate_account},
    priority_fee::PriorityFeeOracle,
};
use crate::{ConnectionConf, SealevelProvider, SealevelRpcClient};

const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
const SPL_NOOP: &str = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";

// The max amount of compute units for a transaction.
// TODO: consider a more sane value and/or use IGP gas payments instead.
const PROCESS_COMPUTE_UNITS: u32 = 1_400_000;

/// The max amount of compute units for a transaction.
const MAX_COMPUTE_UNITS: u32 = 1_400_000;

/// 0.0005 SOL, in lamports.
/// A typical tx fee without a prioritization fee is 0.000005 SOL, or
/// 5000 lamports. (Example: https://explorer.solana.com/tx/fNd3xVeBzFHeuzr8dXQxLGiHMzTeYpykSV25xWzNRaHtzzjvY9A3MzXh1ZsK2JncRHkwtuWrGEwGXVhFaUCYhtx)
/// See average priority fees here https://solanacompass.com/statistics/fees
/// to inform what to spend here.
const PROCESS_DESIRED_PRIORITIZATION_FEE_LAMPORTS_PER_TX: u64 = 500000;

/// In micro-lamports. Multiply this by the compute units to figure out
/// the additional cost of processing a message, in addition to the mandatory
/// "base" cost of signature verification.
/// Unused at the moment, but kept for future reference.
#[allow(dead_code)]
const PROCESS_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: u64 =
    // Convert to micro-lamports
    (PROCESS_DESIRED_PRIORITIZATION_FEE_LAMPORTS_PER_TX * 1_000_000)
    // Divide by the max compute units
    / PROCESS_COMPUTE_UNITS as u64;

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
    pub(crate) provider: SealevelProvider,
    payer: Option<Keypair>,
    priority_fee_oracle: Box<dyn PriorityFeeOracle>,
    tx_submitter: Box<dyn TransactionSubmitter>,
}

impl SealevelMailbox {
    /// Create a new sealevel mailbox
    pub fn new(
        conf: &ConnectionConf,
        locator: ContractLocator,
        payer: Option<Keypair>,
    ) -> ChainResult<Self> {
        let provider = SealevelProvider::new(locator.domain.clone(), conf);
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
            tx_submitter: conf
                .transaction_submitter
                .create_submitter(provider.rpc().url()),
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

    /// Get the provider RPC client.
    pub fn rpc(&self) -> &SealevelRpcClient {
        self.provider.rpc()
    }

    /// Simulates an instruction, and attempts to deserialize it into a T.
    /// If no return data at all was returned, returns Ok(None).
    /// If some return data was returned but deserialization was unsuccessful,
    /// an Err is returned.
    pub async fn simulate_instruction<T: BorshDeserialize + BorshSerialize>(
        &self,
        instruction: Instruction,
    ) -> ChainResult<Option<T>> {
        self.rpc()
            .simulate_instruction(
                self.payer
                    .as_ref()
                    .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?,
                instruction,
            )
            .await
    }

    /// Simulates an Instruction that will return a list of AccountMetas.
    pub async fn get_account_metas(
        &self,
        instruction: Instruction,
    ) -> ChainResult<Vec<AccountMeta>> {
        self.rpc()
            .get_account_metas(
                self.payer
                    .as_ref()
                    .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?,
                instruction,
            )
            .await
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
        self.get_account_metas_with_instruction_bytes(
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
        self.get_account_metas_with_instruction_bytes(
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
            .get_account_metas_with_instruction_bytes(
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

    async fn get_account_metas_with_instruction_bytes(
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

        self.get_account_metas(instruction).await
    }

    /// Builds a transaction with estimated costs for a given instruction.
    async fn build_estimated_tx_for_instruction(
        &self,
        instruction: Instruction,
    ) -> ChainResult<Transaction> {
        // Build a transaction that sets the max compute units and a dummy compute unit price.
        // This is used for simulation to get the actual compute unit limit. We set dummy values
        // for the compute unit limit and price because we want to include the instructions that
        // set these in the cost estimate.
        let simulation_tx = self
            .create_transaction_for_instruction(MAX_COMPUTE_UNITS, 0, instruction.clone(), false)
            .await?;

        let simulation_result = self
            .provider
            .rpc()
            .simulate_transaction(&simulation_tx)
            .await?;
        tracing::debug!(?simulation_result, "Got simulation result for transaction");

        // If there was an error in the simulation result, return an error.
        if simulation_result.err.is_some() {
            return Err(ChainCommunicationError::from_other_str(
                format!("Error in simulation result: {:?}", simulation_result.err).as_str(),
            ));
        }

        // Get the compute units used in the simulation result, requiring
        // that it is greater than 0.
        let simulation_compute_units: u32 = simulation_result
            .units_consumed
            .and_then(|units| if units > 0 { Some(units) } else { None })
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str(
                    "Empty or zero compute units returned in simulation result",
                )
            })?
            .try_into()
            .map_err(ChainCommunicationError::from_other)?;

        // Bump the compute units by 10% to ensure we have enough, but cap it at the max.
        let simulation_compute_units = MAX_COMPUTE_UNITS.min((simulation_compute_units * 11) / 10);

        let priority_fee = self
            .priority_fee_oracle
            .get_priority_fee(&simulation_tx)
            .await?;

        tracing::info!(
            ?priority_fee,
            ?simulation_compute_units,
            "Got priority fee and compute units for transaction"
        );

        // Build the final transaction with the correct compute unit limit and price.
        let tx = self
            .create_transaction_for_instruction(
                simulation_compute_units,
                priority_fee,
                instruction,
                true,
            )
            .await?;

        Ok(tx)
    }

    /// Creates a transaction for a given instruction, compute unit limit, and compute unit price.
    /// If `blockhash` is `None`, the latest blockhash is fetched from the RPC.
    async fn create_transaction_for_instruction(
        &self,
        compute_unit_limit: u32,
        compute_unit_price_micro_lamports: u64,
        instruction: Instruction,
        sign: bool,
    ) -> ChainResult<Transaction> {
        let payer = self.get_payer()?;

        let instructions = vec![
            // Set the compute unit limit.
            ComputeBudgetInstruction::set_compute_unit_limit(compute_unit_limit),
            // Set the priority fee / tip
            self.tx_submitter.get_priority_fee_instruction(
                compute_unit_price_micro_lamports,
                compute_unit_limit.into(),
                &payer.pubkey(),
            ),
            instruction,
        ];

        let tx = if sign {
            let recent_blockhash = self
                .rpc()
                .get_latest_blockhash_with_commitment(CommitmentConfig::processed())
                .await
                .map_err(ChainCommunicationError::from_other)?;

            Transaction::new_signed_with_payer(
                &instructions,
                Some(&payer.pubkey()),
                &[payer],
                recent_blockhash,
            )
        } else {
            Transaction::new_unsigned(Message::new(&instructions, Some(&payer.pubkey())))
        };

        Ok(tx)
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

    async fn get_inbox(&self) -> ChainResult<Box<Inbox>> {
        let account = self
            .rpc()
            .get_account_with_finalized_commitment(&self.inbox.0)
            .await?;
        let inbox = InboxAccount::fetch(&mut account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        Ok(inbox)
    }

    fn get_payer(&self) -> ChainResult<&Keypair> {
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
            .rpc()
            .get_account_option_with_finalized_commitment(&processed_message_account_key)
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

        let tx = self
            .build_estimated_tx_for_instruction(process_instruction)
            .await?;

        tracing::info!(?tx, "Created sealevel transaction to process message");

        let signature = self.tx_submitter.send_transaction(&tx, true).await?;

        tracing::info!(?tx, ?signature, "Sealevel transaction sent");

        let send_instant = std::time::Instant::now();

        // Wait for the transaction to be confirmed.
        self.rpc().wait_for_transaction_confirmation(&tx).await?;

        tracing::info!(?tx, ?signature, time_to_confirm=?send_instant.elapsed(), "Sealevel transaction confirmed");

        // TODO: not sure if this actually checks if the transaction was executed / reverted?
        // Confirm the transaction.
        let executed = self
            .rpc()
            .confirm_transaction_with_commitment(&signature, commitment)
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
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        // TODO use correct data upon integrating IGP support
        Ok(TxCostEstimate {
            gas_limit: U256::zero(),
            gas_price: FixedPointNumber::zero(),
            l2_gas_limit: None,
        })
    }

    fn process_calldata(&self, _message: &HyperlaneMessage, _metadata: &[u8]) -> Vec<u8> {
        todo!()
    }
}

/// Struct that retrieves event data for a Sealevel Mailbox contract
#[derive(Debug)]
pub struct SealevelMailboxIndexer {
    mailbox: SealevelMailbox,
    program_id: Pubkey,
    dispatch_message_log_meta_composer: LogMetaComposer,
    delivery_message_log_meta_composer: LogMetaComposer,
    advanced_log_meta: bool,
}

impl SealevelMailboxIndexer {
    /// Create a new SealevelMailboxIndexer
    pub fn new(
        conf: &ConnectionConf,
        locator: ContractLocator,
        advanced_log_meta: bool,
    ) -> ChainResult<Self> {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        let mailbox = SealevelMailbox::new(conf, locator, None)?;

        let dispatch_message_log_meta_composer = LogMetaComposer::new(
            mailbox.program_id,
            "message dispatch".to_owned(),
            is_message_dispatch_instruction,
        );

        let delivery_message_log_meta_composer = LogMetaComposer::new(
            mailbox.program_id,
            "message delivery".to_owned(),
            is_message_delivery_instruction,
        );

        Ok(Self {
            program_id,
            mailbox,
            dispatch_message_log_meta_composer,
            delivery_message_log_meta_composer,
            advanced_log_meta,
        })
    }

    fn rpc(&self) -> &SealevelRpcClient {
        self.mailbox.rpc()
    }

    async fn get_dispatched_message_with_nonce(
        &self,
        nonce: u32,
    ) -> ChainResult<(Indexed<HyperlaneMessage>, LogMeta)> {
        let nonce_bytes = nonce.to_le_bytes();
        let unique_dispatched_message_pubkey_offset = 1 + 8 + 4 + 8; // the offset to get the `unique_message_pubkey` field
        let unique_dispatch_message_pubkey_length = 32; // the length of the `unique_message_pubkey` field
        let accounts = search_accounts_by_discriminator(
            self.rpc(),
            &self.program_id,
            DISPATCHED_MESSAGE_DISCRIMINATOR,
            &nonce_bytes,
            unique_dispatched_message_pubkey_offset,
            unique_dispatch_message_pubkey_length,
        )
        .await?;

        let valid_message_storage_pda_pubkey = search_and_validate_account(accounts, |account| {
            self.dispatched_message_account(account)
        })?;

        // Now that we have the valid message storage PDA pubkey, we can get the full account data.
        let account = self
            .rpc()
            .get_account_with_finalized_commitment(&valid_message_storage_pda_pubkey)
            .await?;
        let dispatched_message_account =
            DispatchedMessageAccount::fetch(&mut account.data.as_ref())
                .map_err(ChainCommunicationError::from_other)?
                .into_inner();
        let hyperlane_message =
            HyperlaneMessage::read_from(&mut &dispatched_message_account.encoded_message[..])?;

        let log_meta = if self.advanced_log_meta {
            self.dispatch_message_log_meta(
                U256::from(nonce),
                &valid_message_storage_pda_pubkey,
                &dispatched_message_account.slot,
            )
            .await?
        } else {
            LogMeta {
                address: self.program_id.to_bytes().into(),
                block_number: dispatched_message_account.slot,
                // TODO: get these when building out scraper support.
                // It's inconvenient to get these :|
                block_hash: H256::zero(),
                transaction_id: H512::zero(),
                transaction_index: 0,
                log_index: U256::zero(),
            }
        };

        Ok((hyperlane_message.into(), log_meta))
    }

    fn dispatched_message_account(&self, account: &Account) -> ChainResult<Pubkey> {
        let unique_message_pubkey = Pubkey::new(&account.data);
        let (expected_pubkey, _bump) = Pubkey::try_find_program_address(
            mailbox_dispatched_message_pda_seeds!(unique_message_pubkey),
            &self.mailbox.program_id,
        )
        .ok_or_else(|| {
            ChainCommunicationError::from_other_str(
                "Could not find program address for unique message pubkey",
            )
        })?;
        Ok(expected_pubkey)
    }

    async fn dispatch_message_log_meta(
        &self,
        log_index: U256,
        message_storage_pda_pubkey: &Pubkey,
        message_account_slot: &Slot,
    ) -> ChainResult<LogMeta> {
        let block = self
            .mailbox
            .provider
            .rpc()
            .get_block(*message_account_slot)
            .await?;

        self.dispatch_message_log_meta_composer
            .log_meta(
                block,
                log_index,
                message_storage_pda_pubkey,
                message_account_slot,
            )
            .map_err(Into::<ChainCommunicationError>::into)
    }

    async fn get_delivered_message_with_sequence(
        &self,
        sequence: u32,
    ) -> ChainResult<(Indexed<H256>, LogMeta)> {
        let sequence_bytes = sequence.to_le_bytes();
        let delivered_message_id_offset = 1 + 8 + 8; // the offset to get the `message_id` field
        let delivered_message_id_length = 32;
        let accounts = search_accounts_by_discriminator(
            self.rpc(),
            &self.program_id,
            PROCESSED_MESSAGE_DISCRIMINATOR,
            &sequence_bytes,
            delivered_message_id_offset,
            delivered_message_id_length,
        )
        .await?;

        debug!(account_len = ?accounts.len(), "Found accounts with processed message discriminator");

        let valid_message_storage_pda_pubkey = search_and_validate_account(accounts, |account| {
            self.delivered_message_account(account)
        })?;

        // Now that we have the valid delivered message storage PDA pubkey,
        // we can get the full account data.
        let account = self
            .rpc()
            .get_account_with_finalized_commitment(&valid_message_storage_pda_pubkey)
            .await?;
        let delivered_message_account = ProcessedMessageAccount::fetch(&mut account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        let message_id = delivered_message_account.message_id;

        let log_meta = if self.advanced_log_meta {
            self.delivered_message_log_meta(
                U256::from(sequence),
                &valid_message_storage_pda_pubkey,
                &delivered_message_account.slot,
            )
            .await?
        } else {
            LogMeta {
                address: self.program_id.to_bytes().into(),
                block_number: delivered_message_account.slot,
                // TODO: get these when building out scraper support.
                // It's inconvenient to get these :|
                block_hash: H256::zero(),
                transaction_id: H512::zero(),
                transaction_index: 0,
                log_index: U256::zero(),
            }
        };

        let mut indexed = Indexed::from(message_id);
        indexed.sequence = Some(sequence);

        Ok((indexed, log_meta))
    }

    fn delivered_message_account(&self, account: &Account) -> ChainResult<Pubkey> {
        let message_id = H256::from_slice(&account.data);
        let (expected_pubkey, _bump) = Pubkey::try_find_program_address(
            mailbox_processed_message_pda_seeds!(message_id),
            &self.mailbox.program_id,
        )
        .ok_or_else(|| {
            ChainCommunicationError::from_other_str("Could not find program address for message id")
        })?;
        Ok(expected_pubkey)
    }

    async fn delivered_message_log_meta(
        &self,
        log_index: U256,
        message_storage_pda_pubkey: &Pubkey,
        message_account_slot: &Slot,
    ) -> ChainResult<LogMeta> {
        let block = self
            .mailbox
            .provider
            .rpc()
            .get_block(*message_account_slot)
            .await?;

        self.delivery_message_log_meta_composer
            .log_meta(
                block,
                log_index,
                message_storage_pda_pubkey,
                message_account_slot,
            )
            .map_err(Into::<ChainCommunicationError>::into)
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for SealevelMailboxIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        info!(
            ?range,
            "Fetching SealevelMailboxIndexer HyperlaneMessage logs"
        );

        let message_capacity = range.end().saturating_sub(*range.start());
        let mut messages = Vec::with_capacity(message_capacity as usize);
        for nonce in range {
            messages.push(self.get_dispatched_message_with_nonce(nonce).await?);
        }
        Ok(messages)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        // we should not report block height since SequenceAwareIndexer uses block slot in
        // `latest_sequence_count_and_tip` and we should not report block slot here
        // since block slot cannot be used as watermark
        unimplemented!()
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for SealevelMailboxIndexer {
    #[instrument(err, skip(self))]
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.mailbox.provider.rpc().get_slot().await?;
        // TODO: need to make sure the call and tip are at the same height?
        let count = Mailbox::count(&self.mailbox, &ReorgPeriod::None).await?;
        Ok((Some(count), tip))
    }
}

#[async_trait]
impl Indexer<H256> for SealevelMailboxIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        info!(
            ?range,
            "Fetching SealevelMailboxIndexer HyperlaneMessage Delivery logs"
        );

        let message_capacity = range.end().saturating_sub(*range.start());
        let mut message_ids = Vec::with_capacity(message_capacity as usize);
        for nonce in range {
            message_ids.push(self.get_delivered_message_with_sequence(nonce).await?);
        }
        Ok(message_ids)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        // we should not report block height since SequenceAwareIndexer uses block slot in
        // `latest_sequence_count_and_tip` and we should not report block slot here
        // since block slot cannot be used as watermark
        unimplemented!()
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for SealevelMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let inbox = self.mailbox.get_inbox().await?;
        let sequence = inbox
            .processed_count
            .try_into()
            .map_err(StrOrIntParseError::from)?;

        let tip = self.mailbox.provider.rpc().get_slot().await?;

        Ok((Some(sequence), tip))
    }
}
