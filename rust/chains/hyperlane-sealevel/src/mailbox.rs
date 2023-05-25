#![allow(warnings)] // FIXME remove

use std::{
    collections::HashMap,
    num::NonZeroU64,
    str::FromStr as _,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use borsh::BorshDeserialize;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, ContractLocator, Decode as _, Encode as _,
    HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, IndexRange, Indexer, LogMeta, Mailbox, MessageIndexer, TxCostEstimate,
    TxOutcome, H256, U256, accumulator::incremental::IncrementalMerkle,
};
use tracing::{debug, error, instrument, trace, warn};

use crate::{
    mailbox::contract::DispatchedMessageAccount,
    mailbox_message_storage_pda_seeds, mailbox_process_authority_pda_seeds,
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
    /*make_provider,*/ ConnectionConf, SealevelProvider,
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
        let rpc_client = RpcClient::new(conf.url.to_string());

        // TODO use helper functions from mailbox contract lib
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        let domain = locator.domain.id();
        let inbox = Pubkey::find_program_address(
            &[b"hyperlane", b"-", &domain.to_le_bytes(), b"-", b"inbox"],
            &program_id,
        );
        let outbox = Pubkey::find_program_address(
            &[b"hyperlane", b"-", &domain.to_le_bytes(), b"-", b"outbox"],
            &program_id,
        );

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

    pub async fn get_handle_account_metas(
        &self,
        message: &HyperlaneMessage,
        payer: &Pubkey,
    ) -> ChainResult<Vec<AccountMeta>> {
        let recipient_program_id = Pubkey::new_from_array(message.recipient.into());
        let instruction = contract::MessageRecipientInstruction::HandleAccountMetas(
            contract::HandleInstruction {
                sender: message.sender,
                origin: message.origin,
                message: message.body.clone(),
            },
        );
        let commitment = CommitmentConfig::finalized();
        let (recent_blockhash, _) = self
            .rpc_client
            .get_latest_blockhash_with_commitment(commitment)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        let (account_metas_pda_key, _) = Pubkey::find_program_address(
            contract::HANDLE_ACCOUNT_METAS_PDA_SEEDS,
            &recipient_program_id,
        );
        let account_metas_return_data = self
            .rpc_client
            .simulate_transaction(&Transaction::new_unsigned(Message::new_with_blockhash(
                &[Instruction::new_with_bytes(
                    recipient_program_id,
                    &instruction
                        .encode()
                        .map_err(ChainCommunicationError::from_other)?,
                    vec![AccountMeta::new(account_metas_pda_key, false)],
                )],
                Some(payer),
                &recent_blockhash,
            )))
            .await
            .map_err(ChainCommunicationError::from_other)?
            .value
            .return_data;

        // If there isn't any return data, let's try gracefully handling
        // and assume that there are simply no extra account metas required.
        if let Some(encoded_account_metas) = account_metas_return_data {
            let account_metas_bytes = match encoded_account_metas.data.1 {
                UiReturnDataEncoding::Base64 => base64::decode(encoded_account_metas.data.0)
                    .map_err(ChainCommunicationError::from_other)?,
            };

            let serialized_account_metas: Vec<SerializableAccountMeta> =
                SimulationReturnData::<Vec<SerializableAccountMeta>>::try_from_slice(
                    account_metas_bytes.as_slice(),
                )
                .map_err(ChainCommunicationError::from_other)?
                .return_data;
            let account_metas: Vec<AccountMeta> = serialized_account_metas
                .into_iter()
                .map(|serializable_account_meta| serializable_account_meta.into())
                .collect();

            return Ok(account_metas);
        }

        Ok(vec![])
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

            tree
            .count()
            .try_into()
            .map_err(ChainCommunicationError::from_other)
    }

    #[instrument(err, ret, skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let inbox_account = self
            .rpc_client
            .get_account(&self.inbox.0)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        let inbox = contract::InboxAccount::fetch(&mut inbox_account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        let res = inbox
            .delivered
            .contains(&id.into())
            .try_into()
            .map_err(ChainCommunicationError::from_other);
        res
    }

    #[instrument(err, ret, skip(self))]
    async fn tree(&self, lag: Option<NonZeroU64>) -> ChainResult<IncrementalMerkle> {
        assert!(
            lag.is_none(),
            "Sealevel does not support querying point-in-time"
        );

        let outbox_account = self
            .rpc_client
            .get_account(&self.outbox.0)
            .await
            .map_err(ChainCommunicationError::from_other)?;
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
        let count: u32 = 
            tree
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
        // TODO get from on-chain
        Ok(Pubkey::from_str(contract::DEFAULT_ISM)
            .unwrap()
            .to_bytes()
            .into())
    }

    #[instrument(err, ret, skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        // FIXME what to do with recipient? Just lookup in a mapping of recipient contract to ISM
        // that we pass in via config?
        let _ = recipient;

        let inbox_account = self
            .rpc_client
            .get_account(&self.inbox.0)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        let inbox = contract::InboxAccount::fetch(&mut inbox_account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        Ok(inbox.ism.to_bytes().into())
    }

    #[instrument(err, ret, skip(self))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let inbox_account = self
            .rpc_client
            .get_account(&self.inbox.0)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        let inbox = contract::InboxAccount::fetch(&mut inbox_account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        let mut instructions = Vec::with_capacity(1);
        let commitment = CommitmentConfig::finalized();

        let recipient: Pubkey = message.recipient.0.into();
        let ism = inbox.ism.to_bytes().into();
        let mut encoded_message = vec![];
        message.write_to(&mut encoded_message).unwrap();

        let (process_authority_key, _process_authority_bump) = Pubkey::try_find_program_address(
            mailbox_process_authority_pda_seeds!(&recipient),
            &self.program_id,
        )
        .ok_or_else(|| {
            ChainCommunicationError::from_other_str(
                "Could not find program address for process authority",
            )
        })?;

        let ixn = contract::Instruction::InboxProcess(contract::InboxProcess {
            metadata: metadata.to_vec(),
            message: encoded_message,
        });
        let ixn_data = ixn
            .into_instruction_data()
            .map_err(ChainCommunicationError::from_other)?;
        let mut accounts = vec![
            AccountMeta::new(self.inbox.0, false),
            AccountMeta::new_readonly(process_authority_key, false),
            AccountMeta::new_readonly(Pubkey::from_str(contract::SPL_NOOP).unwrap(), false),
            AccountMeta::new_readonly(ism, false),
            // Note: we would have to provide ISM accounts accounts here if the contract uses
            // any additional accounts.
            AccountMeta::new_readonly(recipient, false),
        ];

        let payer = self
            .payer
            .as_ref()
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        // Get account metas required for the Handle instruction
        let handle_account_metas = self
            .get_handle_account_metas(message, &payer.pubkey())
            .await?;
        tracing::info!("handle_account_metas {:?}", handle_account_metas);

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
            // .send_transaction(&txn) // TODO just use this. Don't need to skip pre-flight.
            .send_transaction_with_config(
                &txn,
                RpcSendTransactionConfig {
                    skip_preflight: true,
                    ..Default::default()
                },
            )
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
            &nonce.to_be_bytes()[..],
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
        // TODO: need to make sure the call and tip are at the same height!
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
mod contract {

    use super::*;

    use std::{collections::HashSet, io::Read};

    use borsh::{BorshDeserialize, BorshSerialize};
    use hyperlane_core::accumulator::incremental::IncrementalMerkle as MerkleTree;

    use crate::solana::{clock::Slot, instruction::AccountMeta};

    pub static DEFAULT_ISM: &'static str = "6TCwgXydobJUEqabm7e6SL4FMdiFDvp1pmYoL6xXmRJq";
    pub static DEFAULT_ISM_ACCOUNTS: [&'static str; 0] = [];

    pub static SPL_NOOP: &str = "GpiNbGLpyroc8dFKPhK55eQhhvWn3XUaXJFp5fk5aXUs";

    pub const DISPATCHED_MESSAGE_DISCRIMINATOR: &[u8; 8] = b"DISPATCH";

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
        // Note: 10MB account limit is around ~300k entries.
        pub delivered: HashSet<H256>,
        pub ism: Pubkey,
        pub ism_accounts: Vec<Pubkey>,
    }
    impl Default for Inbox {
        fn default() -> Self {
            Self {
                local_domain: 0,
                inbox_bump_seed: 0,
                delivered: Default::default(),
                // TODO can declare_id!() or similar be used for these to compute at compile time?
                ism: Pubkey::from_str(DEFAULT_ISM).unwrap(),
                ism_accounts: DEFAULT_ISM_ACCOUNTS
                    .iter()
                    .map(|account| Pubkey::from_str(account).unwrap())
                    .collect(),
            }
        }
    }

    pub type OutboxAccount = AccountData<Outbox>;
    #[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
    pub struct Outbox {
        pub local_domain: u32,
        pub outbox_bump_seed: u8,
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
        InboxSetDefaultModule(InboxSetDefaultModule),
        OutboxDispatch(OutboxDispatch),
        OutboxGetCount(OutboxQuery),
        OutboxGetLatestCheckpoint(OutboxQuery),
        OutboxGetRoot(OutboxQuery),
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
        pub local_domain: u32,
        pub destination_domain: u32,
        pub recipient: H256,
        pub message_body: Vec<u8>,
    }

    #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
    pub struct OutboxQuery {
        pub local_domain: u32,
    }

    // Note: maximum transaction size is ~1kB, so will need to use accounts for large messages.
    #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
    pub struct InboxProcess {
        pub metadata: Vec<u8>, // Encoded Multi-Signature ISM data, or similar.
        pub message: Vec<u8>,  // Encoded HyperlaneMessage
    }

    #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
    pub struct InboxSetDefaultModule {
        pub local_domain: u32,
        pub program_id: Pubkey,
        pub accounts: Vec<Pubkey>,
    }

    pub enum MessageRecipientInstruction {
        HandleAccountMetas(HandleInstruction),
    }

    impl MessageRecipientInstruction {
        pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
            let mut buf = vec![];
            match self {
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

    #[derive(Eq, PartialEq, BorshSerialize, BorshDeserialize, Debug)]
    pub struct HandleInstruction {
        pub origin: u32,
        pub sender: H256,
        pub message: Vec<u8>,
    }

    /// First 8 bytes of `hash::hashv(&[b"hyperlane-message-recipient:handle-account-metas"])`
    pub const HANDLE_ACCOUNT_METAS_DISCRIMINATOR: [u8; 8] = [194, 141, 30, 82, 241, 41, 169, 52];
    pub const HANDLE_ACCOUNT_METAS_DISCRIMINATOR_SLICE: &[u8] = &HANDLE_ACCOUNT_METAS_DISCRIMINATOR;

    /// Seeds for the PDA that's expected to be passed into the `HandleAccountMetas`
    /// instruction.
    pub const HANDLE_ACCOUNT_METAS_PDA_SEEDS: &[&[u8]] = &[
        b"hyperlane-message-recipient",
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

    pub type DispatchedMessageAccount = AccountData<DispatchedMessage>;

    #[derive(Debug, Default)]
    pub struct DispatchedMessage {
        pub discriminator: [u8; 8],
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
            writer.write_all(&self.nonce.to_be_bytes())?;
            writer.write_all(&self.slot.to_be_bytes())?;
            writer.write_all(&self.unique_message_pubkey.to_bytes())?;
            writer.write_all(&self.encoded_message)?;
            Ok(())
        }
    }

    impl BorshDeserialize for DispatchedMessage {
        fn deserialize(reader: &mut &[u8]) -> std::io::Result<Self> {
            let mut discriminator = [0u8; 8];
            reader.read_exact(&mut discriminator)?;
            if &discriminator != DISPATCHED_MESSAGE_DISCRIMINATOR {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "invalid discriminator",
                ));
            }

            let mut nonce = [0u8; 4];
            reader.read_exact(&mut nonce)?;

            let mut slot = [0u8; 8];
            reader.read_exact(&mut slot)?;

            let mut unique_message_pubkey = [0u8; 32];
            reader.read_exact(&mut unique_message_pubkey)?;

            let mut encoded_message = vec![];
            reader.read_to_end(&mut encoded_message)?;

            Ok(Self {
                discriminator,
                nonce: u32::from_be_bytes(nonce),
                slot: u64::from_be_bytes(slot),
                unique_message_pubkey: Pubkey::new_from_array(unique_message_pubkey),
                encoded_message,
            })
        }
    }
}
//-------------------------------------------------------------------------------------------------
