#![allow(warnings)] // FIXME remove

use std::{
    collections::HashMap,
    num::NonZeroU64,
    str::FromStr as _,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult, Checkpoint,
    ContractLocator, Decode as _, Encode as _, HyperlaneAbi, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, IndexRange, Indexer, LogMeta, Mailbox,
    MessageIndexer, TxCostEstimate, TxOutcome, H256, U256,
};
use jsonrpc_core::futures_util::TryFutureExt;
use tracing::{debug, error, instrument, trace, warn};

use crate::{
    mailbox::contract::DispatchedMessageAccount,
    mailbox_inbox_pda_seeds, mailbox_message_storage_pda_seeds, mailbox_outbox_pda_seeds,
    mailbox_process_authority_pda_seeds, mailbox_processed_message_pda_seeds,
    solana::{
        account::Account,
        account_decoder::{UiAccountEncoding, UiDataSliceConfig},
        commitment_config::CommitmentConfig,
        hash::Hash,
        instruction::{AccountMeta, Instruction},
        message::Message,
        nonblocking_rpc_client::RpcClient,
        pubkey::Pubkey,
        rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig, RpcSendTransactionConfig},
        rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType},
        signature::Signature,
        signer::{keypair::Keypair, Signer as _},
        transaction::{Transaction, VersionedTransaction},
        transaction_status::{
            EncodedConfirmedBlock, EncodedTransaction, EncodedTransactionWithStatusMeta,
            UiInnerInstructions, UiInstruction, UiMessage, UiParsedInstruction,
            UiReturnDataEncoding, UiTransaction, UiTransactionReturnData, UiTransactionStatusMeta,
        },
    },
    utils::{get_account_metas, simulate_instruction},
    ConnectionConf, SealevelProvider,
};

use crate::RpcClientWithDebug;

use self::contract::{
    SerializableAccountMeta, SimulationReturnData, DISPATCHED_MESSAGE_DISCRIMINATOR,
};

// FIXME solana uses the first 64 byte signature of a transaction to uniquely identify the
// transaction rather than a 32 byte transaction hash like ethereum. Hash it here to reduce
// size - requires more thought to ensure this makes sense to do...
fn signature_to_txn_hash(signature: &Signature) -> H256 {
    H256::from(crate::solana::hash::hash(signature.as_ref()).to_bytes())
}

// The max amount of compute units for a transaction.
// TODO: consider a more sane value and/or use IGP gas payments instead.
const PROCESS_COMPUTE_UNITS: u32 = 1_400_000;

/// A reference to a Mailbox contract on some Sealevel chain
pub struct SealevelMailbox {
    program_id: Pubkey,
    inbox: (Pubkey, u8),
    outbox: (Pubkey, u8),
    rpc_client: RpcClient,
    domain: HyperlaneDomain,
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
            &contract::Instruction::InboxGetRecipientIsm(recipient_program_id),
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
        let (account_metas_pda_key, _) = Pubkey::find_program_address(
            contract::INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS,
            &recipient_program_id,
        );
        let instruction =
            contract::MessageRecipientInstruction::InterchainSecurityModuleAccountMetas;
        let instruction = Instruction::new_with_bytes(
            recipient_program_id,
            &instruction
                .encode()
                .map_err(ChainCommunicationError::from_other)?,
            vec![AccountMeta::new(account_metas_pda_key, false)],
        );

        self.get_account_metas(instruction).await
    }

    /// Gets the account metas required for the ISM's `Verify` instruction.
    pub async fn get_ism_verify_account_metas(
        &self,
        ism: Pubkey,
        metadata: Vec<u8>,
        message: Vec<u8>,
    ) -> ChainResult<Vec<AccountMeta>> {
        let (account_metas_pda_key, _) =
            Pubkey::find_program_address(contract::VERIFY_ACCOUNT_METAS_PDA_SEEDS, &ism);
        let instruction = contract::InterchainSecurityModuleInstruction::VerifyAccountMetas(
            contract::VerifyInstruction { metadata, message },
        );
        let instruction = Instruction::new_with_bytes(
            ism,
            &instruction
                .encode()
                .map_err(ChainCommunicationError::from_other)?,
            vec![AccountMeta::new(account_metas_pda_key, false)],
        );

        self.get_account_metas(instruction).await
    }

    /// Gets the account metas required for the recipient's `MessageRecipientInstruction::Handle` instruction.
    pub async fn get_handle_account_metas(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<Vec<AccountMeta>> {
        let recipient_program_id = Pubkey::new_from_array(message.recipient.into());
        let instruction = contract::MessageRecipientInstruction::HandleAccountMetas(
            contract::HandleInstruction {
                sender: message.sender,
                origin: message.origin,
                message: message.body.clone(),
            },
        );
        let (account_metas_pda_key, _) = Pubkey::find_program_address(
            contract::HANDLE_ACCOUNT_METAS_PDA_SEEDS,
            &recipient_program_id,
        );
        let instruction = Instruction::new_with_bytes(
            recipient_program_id,
            &instruction
                .encode()
                .map_err(ChainCommunicationError::from_other)?,
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
        let tree = self.tree(_maybe_lag).await?;

        tree.count()
            .try_into()
            .map_err(ChainCommunicationError::from_other)
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
    async fn tree(&self, lag: Option<NonZeroU64>) -> ChainResult<IncrementalMerkle> {
        assert!(
            lag.is_none(),
            "Sealevel does not support querying point-in-time"
        );

        let outbox_account = self
            .rpc_client
            .get_account_with_commitment(&self.outbox.0, CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("Could not find account data")
            })?;
        let outbox = contract::OutboxAccount::fetch(&mut outbox_account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        Ok(outbox.tree)
    }

    #[instrument(err, ret, skip(self))]
    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        assert!(
            lag.is_none(),
            "Sealevel does not support querying point-in-time"
        );

        let tree = self.tree(lag).await?;

        let root = tree.root();
        let count: u32 = tree
            .count()
            .try_into()
            .map_err(ChainCommunicationError::from_other)?;
        let index = count.checked_sub(1).ok_or_else(|| {
            ChainCommunicationError::from_contract_error_str(
                "Outbox is empty, cannot compute checkpoint",
            )
        })?;
        let checkpoint = Checkpoint {
            mailbox_address: self.program_id.to_bytes().into(),
            mailbox_domain: self.domain.id(),
            root,
            index,
        };
        Ok(checkpoint)
    }

    #[instrument(err, ret, skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        let inbox_account = self
            .rpc_client
            .get_account(&self.inbox.0)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        let inbox = contract::InboxAccount::fetch(&mut inbox_account.data.as_ref())
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
        instructions.push(contract::ComputeBudgetInstruction::set_compute_unit_limit(
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

        let ixn = contract::Instruction::InboxProcess(contract::InboxProcess {
            metadata: metadata.to_vec(),
            message: encoded_message.clone(),
        });
        let ixn_data = ixn
            .into_instruction_data()
            .map_err(ChainCommunicationError::from_other)?;

        // Craft the accounts for the transaction.
        let mut accounts: Vec<AccountMeta> = vec![
            AccountMeta::new_readonly(payer.pubkey(), true),
            AccountMeta::new_readonly(Pubkey::from_str(contract::SYSTEM_PROGRAM).unwrap(), false),
            AccountMeta::new(self.inbox.0, false),
            AccountMeta::new_readonly(process_authority_key, false),
            AccountMeta::new(processed_message_account_key, false),
        ];
        accounts.extend(ism_getter_account_metas);
        accounts.extend([
            AccountMeta::new_readonly(Pubkey::from_str(contract::SPL_NOOP).unwrap(), false),
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
        tracing::info!("accounts={:#?}", inbox_instruction.accounts);
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

        let signature = self
            .rpc_client
            .send_and_confirm_transaction(&txn)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        tracing::info!("signature={}", signature);
        tracing::info!("txn={:?}", txn);
        let executed = self
            .rpc_client
            .confirm_transaction_with_commitment(&signature, commitment)
            .await
            .map_err(|err| warn!("Failed to confirm inbox process transaction: {}", err))
            .map(|ctx| ctx.value)
            .unwrap_or(false);
        let txid = signature_to_txn_hash(&signature);

        Ok(TxOutcome {
            txid,
            executed,
            // TODO use correct data
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
        // FIXME do something real
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
            &DISPATCHED_MESSAGE_DISCRIMINATOR[..],
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

        for (pubkey, account) in accounts.iter() {
            let unique_message_pubkey = Pubkey::new(&account.data);
            let (expected_pubkey, _bump) = Pubkey::try_find_program_address(
                mailbox_message_storage_pda_seeds!(unique_message_pubkey),
                &self.mailbox.program_id,
            )
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str(
                    "Could not find program address for unique_message_pubkey",
                )
            })?;
            if expected_pubkey == *pubkey {
                valid_message_storage_pda_pubkey = Some(*pubkey);
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
                // TODO real values?
                // It's inconvenient to get these :|
                block_hash: H256::zero(),
                transaction_hash: H256::zero(),
                transaction_index: 0,
                log_index: U256::zero(),
            },
        ))
    }
}

#[async_trait]
impl MessageIndexer for SealevelMailboxIndexer {
    #[instrument(err, skip(self))]
    async fn fetch_count_at_tip(&self) -> ChainResult<(u32, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(self as _).await?;
        // TODO: need to make sure the call and tip are at the same height?
        let count = self.mailbox.count(None).await?;
        Ok((count, tip))
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for SealevelMailboxIndexer {
    async fn fetch_logs(&self, range: IndexRange) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {
        let (from, to) = match range {
            IndexRange::Blocks(from, to) => {
                return Err(ChainCommunicationError::from_other_str(
                    "SealevelMailboxIndexer does not support block-based indexing",
                ))
            }
            IndexRange::Sequences(from, to) => (from, to),
        };

        tracing::info!(
            "Fetching SealevelMailboxIndexer HyperlaneMessage logs from {} to {}",
            from,
            to
        );

        let expected_count: usize = (to - from)
            .try_into()
            .map_err(ChainCommunicationError::from_other)?;
        let mut messages = Vec::with_capacity(expected_count);
        for nonce in from..to {
            messages.push(self.get_message_with_nonce(nonce).await?);
        }
        Ok(messages)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
    }
}

#[async_trait]
impl Indexer<H256> for SealevelMailboxIndexer {
    async fn fetch_logs(&self, _range: IndexRange) -> ChainResult<Vec<(H256, LogMeta)>> {
        todo!()
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
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

//-------------------------------------------------------------------------------------------------
// FIXME mostly copypasta from sealevel contracts
//-------------------------------------------------------------------------------------------------
pub(crate) mod contract {

    use super::*;

    use std::{collections::HashSet, io::Read};

    use borsh::{BorshDeserialize, BorshSerialize};
    use hyperlane_core::accumulator::incremental::IncrementalMerkle as MerkleTree;

    use crate::solana::{
        clock::Slot,
        instruction::{AccountMeta, Instruction as SolanaInstruction},
    };

    pub static DEFAULT_ISM: &'static str = "6TCwgXydobJUEqabm7e6SL4FMdiFDvp1pmYoL6xXmRJq";

    pub static SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
    pub static SPL_NOOP: &str = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";

    pub static COMPUTE_BUDGET: &str = "ComputeBudget111111111111111111111111111111";

    pub const DISPATCHED_MESSAGE_DISCRIMINATOR: &[u8; DISCRIMINATOR_LENGTH] = b"DISPATCH";

    pub trait Data: BorshDeserialize + BorshSerialize + Default {}
    impl<T> Data for T where T: BorshDeserialize + BorshSerialize + Default {}

    #[derive(Debug, thiserror::Error)]
    pub enum AccountError {
        #[error(transparent)]
        Io(std::io::Error),
    }

    /// Account data structure wrapper type that handles initialization and (de)serialization.
    ///
    /// (De)serialization is done with borsh and the "on-disk" format is as follows:
    /// {
    ///     initialized: bool,
    ///     data: T,
    /// }
    #[derive(Debug, Default)]
    pub struct AccountData<T> {
        data: T,
    }

    impl<T> From<T> for AccountData<T> {
        fn from(data: T) -> Self {
            Self { data }
        }
    }

    impl<T> AccountData<T>
    where
        T: Data,
    {
        pub fn into_inner(self) -> T {
            self.data
        }

        pub fn fetch(buf: &mut &[u8]) -> Result<Self, AccountError> {
            // Account data is zero initialized.
            let initialized = bool::deserialize(buf).map_err(AccountError::Io)?;
            let data = if initialized {
                T::deserialize(buf).map_err(AccountError::Io)?
            } else {
                T::default()
            };
            Ok(Self { data })
        }
    }

    pub type InboxAccount = AccountData<Inbox>;
    #[derive(BorshSerialize, BorshDeserialize, Debug)]
    pub struct Inbox {
        pub local_domain: u32,
        pub inbox_bump_seed: u8,
        pub default_ism: Pubkey,
        pub processed_count: u64,
    }
    impl Default for Inbox {
        fn default() -> Self {
            Self {
                local_domain: 0,
                inbox_bump_seed: 0,
                default_ism: Pubkey::from_str(DEFAULT_ISM).unwrap(),
                processed_count: 0,
            }
        }
    }

    pub type OutboxAccount = AccountData<Outbox>;
    #[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
    pub struct Outbox {
        pub local_domain: u32,
        pub outbox_bump_seed: u8,
        pub owner: Option<Pubkey>,
        pub tree: MerkleTree,
    }

    #[derive(Debug, thiserror::Error)]
    pub enum ProgramError {
        // #[error("An instruction's data contents was invalid")]
        // InvalidInstructionData,
        #[error("IO Error: {0}")]
        BorshIoError(String),
    }

    #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
    pub enum Instruction {
        Init(Init),
        InboxProcess(InboxProcess),
        InboxSetDefaultIsm(Pubkey),
        InboxGetRecipientIsm(Pubkey),
        OutboxDispatch(OutboxDispatch),
        OutboxGetCount,
        OutboxGetLatestCheckpoint,
        OutboxGetRoot,
    }

    impl Instruction {
        // pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        //     Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
        // }

        pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
            self.try_to_vec()
                .map_err(|err| ProgramError::BorshIoError(err.to_string()))
        }
    }

    #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
    pub struct Init {
        pub local_domain: u32,
        pub inbox_bump_seed: u8,
        pub outbox_bump_seed: u8,
    }

    #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
    pub struct OutboxDispatch {
        // The sender may not necessarily be the transaction payer so specify separately.
        pub sender: Pubkey,
        pub destination_domain: u32,
        pub recipient: H256,
        pub message_body: Vec<u8>,
    }

    // Note: maximum transaction size is ~1kB, so will need to use accounts for large messages.
    #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
    pub struct InboxProcess {
        pub metadata: Vec<u8>, // Encoded Multi-Signature ISM data, or similar.
        pub message: Vec<u8>,  // Encoded HyperlaneMessage
    }

    pub enum MessageRecipientInstruction {
        InterchainSecurityModuleAccountMetas,
        HandleAccountMetas(HandleInstruction),
    }

    impl MessageRecipientInstruction {
        pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
            let mut buf = vec![];
            match self {
                MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                    buf.extend_from_slice(
                        &INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR_SLICE[..],
                    );
                }
                MessageRecipientInstruction::HandleAccountMetas(instruction) => {
                    buf.extend_from_slice(&HANDLE_ACCOUNT_METAS_DISCRIMINATOR_SLICE[..]);
                    buf.extend_from_slice(
                        &instruction
                            .try_to_vec()
                            .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
                    );
                }
            }

            Ok(buf)
        }
    }

    /// First 8 bytes of `hash::hashv(&[b"hyperlane-message-recipient:interchain-security-module-account-metas"])`
    const INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR: [u8; DISCRIMINATOR_LENGTH] =
        [190, 214, 218, 129, 67, 97, 4, 76];
    const INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR_SLICE: &[u8] =
        &INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_DISCRIMINATOR;

    /// Seeds for the PDA that's expected to be passed into the `InterchainSecurityModuleAccountMetas`
    /// instruction.
    pub const INTERCHAIN_SECURITY_MODULE_ACCOUNT_METAS_PDA_SEEDS: &[&[u8]] = &[
        b"hyperlane_message_recipient",
        b"-",
        b"interchain_security_module",
        b"-",
        b"account_metas",
    ];

    #[derive(Eq, PartialEq, BorshSerialize, BorshDeserialize, Debug)]
    pub struct HandleInstruction {
        pub origin: u32,
        pub sender: H256,
        pub message: Vec<u8>,
    }

    const DISCRIMINATOR_LENGTH: usize = 8;

    /// First 8 bytes of `hash::hashv(&[b"hyperlane-message-recipient:handle-account-metas"])`
    pub const HANDLE_ACCOUNT_METAS_DISCRIMINATOR: [u8; DISCRIMINATOR_LENGTH] =
        [194, 141, 30, 82, 241, 41, 169, 52];
    pub const HANDLE_ACCOUNT_METAS_DISCRIMINATOR_SLICE: &[u8] = &HANDLE_ACCOUNT_METAS_DISCRIMINATOR;

    /// Seeds for the PDA that's expected to be passed into the `HandleAccountMetas`
    /// instruction.
    pub const HANDLE_ACCOUNT_METAS_PDA_SEEDS: &[&[u8]] = &[
        b"hyperlane_message_recipient",
        b"-",
        b"handle",
        b"-",
        b"account_metas",
    ];

    /// A borsh-serializable version of `AccountMeta`.
    #[derive(Debug, BorshSerialize, BorshDeserialize)]
    pub struct SerializableAccountMeta {
        pub pubkey: Pubkey,
        pub is_signer: bool,
        pub is_writable: bool,
    }

    impl From<AccountMeta> for SerializableAccountMeta {
        fn from(account_meta: AccountMeta) -> Self {
            Self {
                pubkey: account_meta.pubkey,
                is_signer: account_meta.is_signer,
                is_writable: account_meta.is_writable,
            }
        }
    }

    impl Into<AccountMeta> for SerializableAccountMeta {
        fn into(self) -> AccountMeta {
            AccountMeta {
                pubkey: self.pubkey,
                is_signer: self.is_signer,
                is_writable: self.is_writable,
            }
        }
    }

    /// A ridiculous workaround for https://github.com/solana-labs/solana/issues/31391,
    /// which is a bug where if a simulated transaction's return data ends with zero byte(s),
    /// they end up being incorrectly truncated.
    /// As a workaround, we can (de)serialize data with a trailing non-zero byte.
    #[derive(Debug, BorshSerialize, BorshDeserialize)]
    pub struct SimulationReturnData<T>
    where
        T: BorshSerialize + BorshDeserialize,
    {
        pub return_data: T,
        trailing_byte: u8,
    }

    impl<T> SimulationReturnData<T>
    where
        T: BorshSerialize + BorshDeserialize,
    {
        pub fn new(return_data: T) -> Self {
            Self {
                return_data,
                trailing_byte: u8::MAX,
            }
        }
    }

    /// PDA seeds for the Inbox account.
    #[macro_export]
    macro_rules! mailbox_inbox_pda_seeds {
        () => {{
            &[b"hyperlane", b"-", b"inbox"]
        }};

        ($bump_seed:expr) => {{
            &[b"hyperlane", b"-", b"inbox", &[$bump_seed]]
        }};
    }

    /// PDA seeds for the Outbox account.
    #[macro_export]
    macro_rules! mailbox_outbox_pda_seeds {
        () => {{
            &[b"hyperlane", b"-", b"outbox"]
        }};

        ($bump_seed:expr) => {{
            &[b"hyperlane", b"-", b"outbox", &[$bump_seed]]
        }};
    }

    /// Gets the PDA seeds for a message storage account that's
    /// based upon the pubkey of a unique message account.
    #[macro_export]
    macro_rules! mailbox_message_storage_pda_seeds {
        ($unique_message_pubkey:expr) => {{
            &[
                b"hyperlane",
                b"-",
                b"dispatched_message",
                b"-",
                $unique_message_pubkey.as_ref(),
            ]
        }};

        ($unique_message_pubkey:expr, $bump_seed:expr) => {{
            &[
                b"hyperlane",
                b"-",
                b"dispatched_message",
                b"-",
                $unique_message_pubkey.as_ref(),
                &[$bump_seed],
            ]
        }};
    }

    /// The PDA seeds relating to the Mailbox's process authority for a particular recipient.
    #[macro_export]
    macro_rules! mailbox_process_authority_pda_seeds {
        ($recipient_pubkey:expr) => {{
            &[
                b"hyperlane",
                b"-",
                b"process_authority",
                b"-",
                $recipient_pubkey.as_ref(),
            ]
        }};

        ($recipient_pubkey:expr, $bump_seed:expr) => {{
            &[
                b"hyperlane",
                b"-",
                b"process_authority",
                b"-",
                $recipient_pubkey.as_ref(),
                &[$bump_seed],
            ]
        }};
    }

    /// The PDA seeds relating to the Mailbox's process authority for a particular recipient.
    #[macro_export]
    macro_rules! mailbox_processed_message_pda_seeds {
        ($message_id_h256:expr) => {{
            &[
                b"hyperlane",
                b"-",
                b"processed_message",
                b"-",
                $message_id_h256.as_bytes(),
            ]
        }};

        ($message_id_h256:expr, $bump_seed:expr) => {{
            &[
                b"hyperlane",
                b"-",
                b"processed_message",
                b"-",
                $message_id_h256.as_bytes(),
                &[$bump_seed],
            ]
        }};
    }

    pub type DispatchedMessageAccount = AccountData<DispatchedMessage>;

    #[derive(Debug, Default)]
    pub struct DispatchedMessage {
        pub discriminator: [u8; DISCRIMINATOR_LENGTH],
        pub nonce: u32,
        pub slot: Slot,
        pub unique_message_pubkey: Pubkey,
        pub encoded_message: Vec<u8>,
    }

    impl DispatchedMessage {
        pub fn new(
            nonce: u32,
            slot: Slot,
            unique_message_pubkey: Pubkey,
            encoded_message: Vec<u8>,
        ) -> Self {
            Self {
                discriminator: *DISPATCHED_MESSAGE_DISCRIMINATOR,
                nonce,
                slot,
                unique_message_pubkey,
                encoded_message,
            }
        }
    }

    impl BorshSerialize for DispatchedMessage {
        fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
            writer.write_all(DISPATCHED_MESSAGE_DISCRIMINATOR)?;
            writer.write_all(&self.nonce.to_le_bytes())?;
            writer.write_all(&self.slot.to_le_bytes())?;
            writer.write_all(&self.unique_message_pubkey.to_bytes())?;
            writer.write_all(&self.encoded_message)?;
            Ok(())
        }
    }

    impl BorshDeserialize for DispatchedMessage {
        fn deserialize(reader: &mut &[u8]) -> std::io::Result<Self> {
            let mut discriminator = [0u8; DISCRIMINATOR_LENGTH];
            reader.read_exact(&mut discriminator)?;
            if &discriminator != DISPATCHED_MESSAGE_DISCRIMINATOR {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "invalid discriminator",
                ));
            }

            let mut nonce = [0u8; 4];
            reader.read_exact(&mut nonce)?;

            let mut slot = [0u8; DISCRIMINATOR_LENGTH];
            reader.read_exact(&mut slot)?;

            let mut unique_message_pubkey = [0u8; 32];
            reader.read_exact(&mut unique_message_pubkey)?;

            let mut encoded_message = vec![];
            reader.read_to_end(&mut encoded_message)?;

            Ok(Self {
                discriminator,
                nonce: u32::from_le_bytes(nonce),
                slot: u64::from_le_bytes(slot),
                unique_message_pubkey: Pubkey::new_from_array(unique_message_pubkey),
                encoded_message,
            })
        }
    }

    // InterchainSecurityModule interface -----

    /// Instructions that a Hyperlane interchain security module is expected to process.
    /// The first 8 bytes of the encoded instruction is a discriminator that
    /// allows programs to implement the required interface.
    #[derive(Clone, Eq, PartialEq, Debug)]
    pub enum InterchainSecurityModuleInstruction {
        /// Gets the type of ISM.
        Type,

        /// Verifies a message.
        // Verify(VerifyInstruction),

        /// Gets the list of AccountMetas required for the `Verify` instruction.
        /// The only account expected to be passed into this instruction is the
        /// read-only PDA relating to the program ID and the seeds `VERIFY_ACCOUNT_METAS_PDA_SEEDS`
        VerifyAccountMetas(VerifyInstruction),
    }

    /// First 8 bytes of `hash::hashv(&[b"hyperlane-interchain-security-module:type"])`
    const TYPE_DISCRIMINATOR: [u8; DISCRIMINATOR_LENGTH] = [105, 97, 97, 88, 63, 124, 106, 18];
    const TYPE_DISCRIMINATOR_SLICE: &[u8] = &TYPE_DISCRIMINATOR;

    /// First 8 bytes of `hash::hashv(&[b"hyperlane-interchain-security-module:verify-account-metas"])`
    const VERIFY_ACCOUNT_METAS_DISCRIMINATOR: [u8; DISCRIMINATOR_LENGTH] =
        [200, 65, 157, 12, 89, 255, 131, 216];
    const VERIFY_ACCOUNT_METAS_DISCRIMINATOR_SLICE: &[u8] = &VERIFY_ACCOUNT_METAS_DISCRIMINATOR;

    /// Seeds for the PDA that's expected to be passed into the `VerifyAccountMetas`
    /// instruction.
    pub const VERIFY_ACCOUNT_METAS_PDA_SEEDS: &[&[u8]] =
        &[b"hyperlane_ism", b"-", b"verify", b"-", b"account_metas"];

    #[derive(Eq, PartialEq, BorshSerialize, BorshDeserialize, Debug, Clone)]
    pub struct VerifyInstruction {
        pub metadata: Vec<u8>,
        pub message: Vec<u8>,
    }

    impl InterchainSecurityModuleInstruction {
        pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
            let mut buf = vec![];
            match self {
                InterchainSecurityModuleInstruction::Type => {
                    buf.extend_from_slice(&TYPE_DISCRIMINATOR_SLICE[..]);
                }
                InterchainSecurityModuleInstruction::VerifyAccountMetas(instruction) => {
                    buf.extend_from_slice(&VERIFY_ACCOUNT_METAS_DISCRIMINATOR_SLICE[..]);
                    buf.extend_from_slice(
                        &instruction
                            .try_to_vec()
                            .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
                    );
                }
            }

            Ok(buf)
        }
    }

    // Compute Budget Instructions
    #[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq, Eq)]
    pub enum ComputeBudgetInstruction {
        /// Deprecated
        RequestUnitsDeprecated {
            /// Units to request
            units: u32,
            /// Additional fee to add
            additional_fee: u32,
        },
        /// Request a specific transaction-wide program heap region size in bytes.
        /// The value requested must be a multiple of 1024. This new heap region
        /// size applies to each program executed in the transaction, including all
        /// calls to CPIs.
        RequestHeapFrame(u32),
        /// Set a specific compute unit limit that the transaction is allowed to consume.
        SetComputeUnitLimit(u32),
        /// Set a compute unit price in "micro-lamports" to pay a higher transaction
        /// fee for higher transaction prioritization.
        SetComputeUnitPrice(u64),
    }

    impl ComputeBudgetInstruction {
        /// Create a `ComputeBudgetInstruction::RequestHeapFrame` `Instruction`
        pub fn request_heap_frame(bytes: u32) -> SolanaInstruction {
            SolanaInstruction::new_with_borsh(Self::id(), &Self::RequestHeapFrame(bytes), vec![])
        }

        /// Create a `ComputeBudgetInstruction::SetComputeUnitLimit` `Instruction`
        pub fn set_compute_unit_limit(units: u32) -> SolanaInstruction {
            SolanaInstruction::new_with_borsh(Self::id(), &Self::SetComputeUnitLimit(units), vec![])
        }

        /// Create a `ComputeBudgetInstruction::SetComputeUnitPrice` `Instruction`
        pub fn set_compute_unit_price(micro_lamports: u64) -> SolanaInstruction {
            SolanaInstruction::new_with_borsh(
                Self::id(),
                &Self::SetComputeUnitPrice(micro_lamports),
                vec![],
            )
        }

        fn id() -> Pubkey {
            Pubkey::from_str(COMPUTE_BUDGET).unwrap()
        }
    }
}
//-------------------------------------------------------------------------------------------------
