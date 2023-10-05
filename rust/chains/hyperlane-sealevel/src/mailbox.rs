#![allow(warnings)] // FIXME remove

use std::{collections::HashMap, num::NonZeroU64, ops::RangeInclusive, str::FromStr as _};

use async_trait::async_trait;
use borsh::{BorshDeserialize, BorshSerialize};
use jsonrpc_core::futures_util::TryFutureExt;
use tracing::{debug, info, instrument, warn};

use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult, Checkpoint,
    ContractLocator, Decode as _, Encode as _, HyperlaneAbi, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Indexer, LogMeta, Mailbox,
    MerkleTreeHook, SequenceIndexer, TxCostEstimate, TxOutcome, H256, H512, U256,
};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use hyperlane_sealevel_mailbox::{
    accounts::{DispatchedMessageAccount, InboxAccount, OutboxAccount},
    instruction::InboxProcess,
    mailbox_dispatched_message_pda_seeds, mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds,
    mailbox_process_authority_pda_seeds, mailbox_processed_message_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use serializable_account_meta::SimulationReturnData;
use solana_account_decoder::{UiAccountEncoding, UiDataSliceConfig};
use solana_client::{
    nonblocking::rpc_client::RpcClient,
    rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig, RpcSendTransactionConfig},
    rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType},
};
use solana_sdk::{
    account::Account,
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    hash::Hash,
    instruction::AccountMeta,
    instruction::Instruction,
    message::Message,
    pubkey::Pubkey,
    signature::Signature,
    signer::{keypair::Keypair, Signer as _},
    transaction::{Transaction, VersionedTransaction},
};
use solana_transaction_status::{
    EncodedConfirmedBlock, EncodedTransaction, EncodedTransactionWithStatusMeta,
    UiInnerInstructions, UiInstruction, UiMessage, UiParsedInstruction, UiReturnDataEncoding,
    UiTransaction, UiTransactionReturnData, UiTransactionStatusMeta,
};

use crate::RpcClientWithDebug;
use crate::{
    utils::{get_account_metas, get_finalized_block_number, simulate_instruction},
    ConnectionConf, SealevelProvider,
};

const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
const SPL_NOOP: &str = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";

// The max amount of compute units for a transaction.
// TODO: consider a more sane value and/or use IGP gas payments instead.
const PROCESS_COMPUTE_UNITS: u32 = 1_400_000;

/// A reference to a Mailbox contract on some Sealevel chain
pub struct SealevelMailbox {
    pub(crate) program_id: Pubkey,
    inbox: (Pubkey, u8),
    pub(crate) outbox: (Pubkey, u8),
    pub(crate) rpc_client: RpcClient,
    pub(crate) domain: HyperlaneDomain,
    payer: Option<Keypair>,
}

impl SealevelMailbox {
    /// Create a new sealevel mailbox
    pub fn new(
        conf: &ConnectionConf,
        locator: ContractLocator,
        payer: Option<Keypair>,
    ) -> ChainResult<Self> {
        // Set the `processed` commitment at rpc level
        let rpc_client =
            RpcClient::new_with_commitment(conf.url.to_string(), CommitmentConfig::processed());

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
            rpc_client,
            domain: locator.domain.clone(),
            payer,
        })
    }

    pub fn inbox(&self) -> (Pubkey, u8) {
        self.inbox
    }
    pub fn outbox(&self) -> (Pubkey, u8) {
        self.outbox
    }

    /// Simulates an instruction, and attempts to deserialize it into a T.
    /// If no return data at all was returned, returns Ok(None).
    /// If some return data was returned but deserialization was unsuccesful,
    /// an Err is returned.
    pub async fn simulate_instruction<T: BorshDeserialize + BorshSerialize>(
        &self,
        instruction: Instruction,
    ) -> ChainResult<Option<T>> {
        simulate_instruction(
            &self.rpc_client,
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
        get_account_metas(
            &self.rpc_client,
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

        self.get_account_metas_with_instruction_bytes(
            recipient_program_id,
            &instruction
                .encode()
                .map_err(ChainCommunicationError::from_other)?,
            hyperlane_sealevel_message_recipient_interface::HANDLE_ACCOUNT_METAS_PDA_SEEDS,
        )
        .await
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
}

impl HyperlaneContract for SealevelMailbox {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(SealevelProvider::new(self.domain.clone()))
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
    async fn count(&self, _maybe_lag: Option<NonZeroU64>) -> ChainResult<u32> {
        <Self as MerkleTreeHook>::count(self, _maybe_lag).await
    }

    #[instrument(err, ret, skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let (processed_message_account_key, _processed_message_account_bump) =
            Pubkey::find_program_address(
                mailbox_processed_message_pda_seeds!(id),
                &self.program_id,
            );

        let account = self
            .rpc_client
            .get_account_with_commitment(
                &processed_message_account_key,
                CommitmentConfig::finalized(),
            )
            .await
            .map_err(ChainCommunicationError::from_other)?;

        Ok(account.value.is_some())
    }

    #[instrument(err, ret, skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        let inbox_account = self
            .rpc_client
            .get_account(&self.inbox.0)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        let inbox = InboxAccount::fetch(&mut inbox_account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

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
        let recipient: Pubkey = message.recipient.0.into();
        let mut encoded_message = vec![];
        message.write_to(&mut encoded_message).unwrap();

        let payer = self
            .payer
            .as_ref()
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        let mut instructions = Vec::with_capacity(2);
        // Set the compute unit limit.
        instructions.push(ComputeBudgetInstruction::set_compute_unit_limit(
            PROCESS_COMPUTE_UNITS,
        ));

        // "processed" level commitment does not guarantee finality.
        // roughly 5% of blocks end up on a dropped fork.
        // However we don't want this function to be a bottleneck and there already
        // is retry logic in the agents.
        let commitment = CommitmentConfig::processed();

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

        let inbox_instruction = Instruction {
            program_id: self.program_id,
            data: ixn_data,
            accounts,
        };
        instructions.push(inbox_instruction);
        let (recent_blockhash, _) = self
            .rpc_client
            .get_latest_blockhash_with_commitment(commitment)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        let txn = Transaction::new_signed_with_payer(
            &instructions,
            Some(&payer.pubkey()),
            &[payer],
            recent_blockhash,
        );

        tracing::info!(?txn, "Created sealevel transaction to process message");

        let signature = self
            .rpc_client
            .send_and_confirm_transaction(&txn)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        tracing::info!(?txn, ?signature, "Sealevel transaction sent");

        let executed = self
            .rpc_client
            .confirm_transaction_with_commitment(&signature, commitment)
            .await
            .map_err(|err| warn!("Failed to confirm inbox process transaction: {}", err))
            .map(|ctx| ctx.value)
            .unwrap_or(false);
        let txid = signature.into();

        Ok(TxOutcome {
            transaction_id: txid,
            executed,
            // TODO use correct data upon integrating IGP support
            gas_price: U256::zero(),
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
            gas_price: U256::zero(),
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
    rpc_client: RpcClientWithDebug,
    mailbox: SealevelMailbox,
    program_id: Pubkey,
}

impl SealevelMailboxIndexer {
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> ChainResult<Self> {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        let rpc_client = RpcClientWithDebug::new(conf.url.to_string());
        let mailbox = SealevelMailbox::new(conf, locator, None)?;
        Ok(Self {
            program_id,
            rpc_client,
            mailbox,
        })
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let height = self
            .rpc_client
            .get_block_height()
            .await
            .map_err(ChainCommunicationError::from_other)?
            .try_into()
            // FIXME solana block height is u64...
            .expect("sealevel block height exceeds u32::MAX");
        Ok(height)
    }

    async fn get_message_with_nonce(&self, nonce: u32) -> ChainResult<(HyperlaneMessage, LogMeta)> {
        let target_message_account_bytes = &[
            &hyperlane_sealevel_mailbox::accounts::DISPATCHED_MESSAGE_DISCRIMINATOR[..],
            &nonce.to_le_bytes()[..],
        ]
        .concat();
        let target_message_account_bytes = base64::encode(target_message_account_bytes);

        // First, find all accounts with the matching account data.
        // To keep responses small in case there is ever more than 1
        // match, we don't request the full account data, and just request
        // the `unique_message_pubkey` field.
        let memcmp = RpcFilterType::Memcmp(Memcmp {
            // Ignore the first byte, which is the `initialized` bool flag.
            offset: 1,
            bytes: MemcmpEncodedBytes::Base64(target_message_account_bytes),
            encoding: None,
        });
        let config = RpcProgramAccountsConfig {
            filters: Some(vec![memcmp]),
            account_config: RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                // Don't return any data
                data_slice: Some(UiDataSliceConfig {
                    offset: 1 + 8 + 4 + 8, // the offset to get the `unique_message_pubkey` field
                    length: 32,            // the length of the `unique_message_pubkey` field
                }),
                commitment: Some(CommitmentConfig::finalized()),
                min_context_slot: None,
            },
            with_context: Some(false),
        };
        let accounts = self
            .rpc_client
            .get_program_accounts_with_config(&self.mailbox.program_id, config)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        // Now loop through matching accounts and find the one with a valid account pubkey
        // that proves it's an actual message storage PDA.
        let mut valid_message_storage_pda_pubkey = Option::<Pubkey>::None;

        for (pubkey, account) in accounts {
            let unique_message_pubkey = Pubkey::new(&account.data);
            let (expected_pubkey, _bump) = Pubkey::try_find_program_address(
                mailbox_dispatched_message_pda_seeds!(unique_message_pubkey),
                &self.mailbox.program_id,
            )
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str(
                    "Could not find program address for unique_message_pubkey",
                )
            })?;
            if expected_pubkey == pubkey {
                valid_message_storage_pda_pubkey = Some(pubkey);
                break;
            }
        }

        let valid_message_storage_pda_pubkey =
            valid_message_storage_pda_pubkey.ok_or_else(|| {
                ChainCommunicationError::from_other_str(
                    "Could not find valid message storage PDA pubkey",
                )
            })?;

        // Now that we have the valid message storage PDA pubkey, we can get the full account data.
        let account = self
            .rpc_client
            .get_account_with_commitment(
                &valid_message_storage_pda_pubkey,
                CommitmentConfig::finalized(),
            )
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("Could not find account data")
            })?;
        let dispatched_message_account =
            DispatchedMessageAccount::fetch(&mut account.data.as_ref())
                .map_err(ChainCommunicationError::from_other)?
                .into_inner();
        let hyperlane_message =
            HyperlaneMessage::read_from(&mut &dispatched_message_account.encoded_message[..])?;

        Ok((
            hyperlane_message,
            LogMeta {
                address: self.mailbox.program_id.to_bytes().into(),
                block_number: dispatched_message_account.slot,
                // TODO: get these when building out scraper support.
                // It's inconvenient to get these :|
                block_hash: H256::zero(),
                transaction_id: H512::zero(),
                transaction_index: 0,
                log_index: U256::zero(),
            },
        ))
    }
}

#[async_trait]
impl SequenceIndexer<HyperlaneMessage> for SealevelMailboxIndexer {
    #[instrument(err, skip(self))]
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(self as _).await?;
        // TODO: need to make sure the call and tip are at the same height?
        let count = Mailbox::count(&self.mailbox, None).await?;
        Ok((Some(count), tip))
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for SealevelMailboxIndexer {
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {
        info!(
            ?range,
            "Fetching SealevelMailboxIndexer HyperlaneMessage logs"
        );

        let message_capacity = range.end().saturating_sub(*range.start());
        let mut messages = Vec::with_capacity(message_capacity as usize);
        for nonce in range {
            messages.push(self.get_message_with_nonce(nonce).await?);
        }
        Ok(messages)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        get_finalized_block_number(&self.rpc_client).await
    }
}

#[async_trait]
impl Indexer<H256> for SealevelMailboxIndexer {
    async fn fetch_logs(&self, _range: RangeInclusive<u32>) -> ChainResult<Vec<(H256, LogMeta)>> {
        todo!()
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceIndexer<H256> for SealevelMailboxIndexer {
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // TODO: implement when sealevel scraper support is implemented
        info!("Message delivery indexing not implemented");
        let tip = Indexer::<H256>::get_finalized_block_number(self).await?;
        Ok((Some(1), tip))
    }
}

struct SealevelMailboxAbi;

// TODO figure out how this is used and if we can support it for sealevel.
impl HyperlaneAbi for SealevelMailboxAbi {
    const SELECTOR_SIZE_BYTES: usize = 8;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        todo!()
    }
}
