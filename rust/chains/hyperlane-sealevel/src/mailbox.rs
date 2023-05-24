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
    TxOutcome, H256, U256,
};
use tracing::{debug, error, instrument, trace, warn};

use crate::{
    mailbox::contract::DispatchedMessageAccount,
    mailbox_message_storage_pda_seeds,
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
    authority: (Pubkey, u8),
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
        let authority = Pubkey::find_program_address(
            &[
                b"hyperlane",
                b"-",
                &domain.to_le_bytes(),
                b"-",
                b"authority",
            ],
            &program_id,
        );
        let inbox = Pubkey::find_program_address(
            &[b"hyperlane", b"-", &domain.to_le_bytes(), b"-", b"inbox"],
            &program_id,
        );
        let outbox = Pubkey::find_program_address(
            &[b"hyperlane", b"-", &domain.to_le_bytes(), b"-", b"outbox"],
            &program_id,
        );

        debug!(
            "domain={}\nmailbox={}\nauthority=({}, {})\ninbox=({}, {})\noutbox=({}, {})",
            domain, program_id, authority.0, authority.1, inbox.0, inbox.1, outbox.0, outbox.1,
        );

        Ok(SealevelMailbox {
            program_id,
            authority,
            inbox,
            outbox,
            rpc_client,
            domain: locator.domain.clone(),
            payer,
        })
    }

    // TODO do we need these accessors?
    pub fn authority(&self) -> (Pubkey, u8) {
        self.authority
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
        // TODO don't duplicate this code, write generic helper function
        let outbox_account = self
            .rpc_client
            .get_account(&self.outbox.0)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        let outbox = contract::OutboxAccount::fetch(&mut outbox_account.data.as_ref())
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        outbox
            .tree
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
    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
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

        let root = outbox.tree.root();
        let count: u32 = outbox
            .tree
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

        let recipient = message.recipient.0.into();
        let ism = inbox.ism.to_bytes().into();
        let mut encoded_message = vec![];
        message.write_to(&mut encoded_message).unwrap();

        let ixn = contract::Instruction::InboxProcess(contract::InboxProcess {
            metadata: metadata.to_vec(),
            message: encoded_message,
        });
        let ixn_data = ixn
            .into_instruction_data()
            .map_err(ChainCommunicationError::from_other)?;
        let mut accounts = vec![
            AccountMeta::new(self.inbox.0, false),
            AccountMeta::new_readonly(self.authority.0, false),
            AccountMeta::new_readonly(Pubkey::from_str(contract::SPL_NOOP).unwrap(), false),
            AccountMeta::new_readonly(ism, false),
            AccountMeta::new_readonly(recipient, false),
            // Note: we would have to provide ISM accounts accounts here if the contract uses
            // any additional accounts.
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

#[derive(Debug, thiserror::Error)]
enum SealevelTxnError {
    #[error("Failed to decode transaction")]
    DecodeFailure,
    #[error("Transaction did not contain required metadata")]
    MissingMetadata,
}

#[derive(Debug)]
enum SealevelTxn {
    Binary(VersionedTransaction),
    Json(UiTransaction),
}

#[derive(Debug)]
enum SealevelTxnIxnLocation {
    Instruction(usize),
    InnerInstruction(usize, usize),
}

#[derive(Debug)]
struct SealevelTxnWithMeta {
    txn: SealevelTxn,
    meta: UiTransactionStatusMeta,
}

impl SealevelTxnWithMeta {
    fn from_encoded(
        encoded: EncodedTransactionWithStatusMeta,
    ) -> Result<Option<Self>, ChainCommunicationError> {
        let txn = match encoded.transaction {
            EncodedTransaction::Accounts(_) => return Ok(None),
            EncodedTransaction::Json(txn) => SealevelTxn::Json(txn),
            encoded => encoded
                .decode()
                .map(|txn| SealevelTxn::Binary(txn))
                .ok_or_else(|| {
                    ChainCommunicationError::from_other(SealevelTxnError::DecodeFailure)
                })?,
        };
        let meta = encoded.meta.ok_or_else(|| {
            ChainCommunicationError::from_other(SealevelTxnError::MissingMetadata)
        })?;
        Ok(Some(Self { txn, meta }))
    }

    // FIXME what if there is more than one mailbox instruction in a transaction? As written, this
    // parsing logic will only find the first. We should really just transform solana's transaction
    // clusterf*ck into some sane and consistent data structure.
    fn contains_program_at_ixn(&self, program_id: &Pubkey) -> Option<SealevelTxnIxnLocation> {
        let inner_ixns: Option<&Vec<UiInnerInstructions>> =
            self.meta.inner_instructions.as_ref().into();
        match &self.txn {
            SealevelTxn::Binary(txn) => {
                let outer_idx =
                    txn.message
                        .instructions()
                        .iter()
                        .enumerate()
                        .find_map(|(idx, ixn)| {
                            (ixn.program_id(txn.message.static_account_keys()) == program_id)
                                .then_some(idx)
                        });
                if outer_idx.is_some() {
                    return outer_idx.map(SealevelTxnIxnLocation::Instruction);
                }
                let inner_ixns = match inner_ixns {
                    Some(inner_ixns) => inner_ixns,
                    None => return None,
                };
                inner_ixns
                    .iter()
                    .flat_map(|inner| {
                        let outer_idx = inner.index;
                        inner
                            .instructions
                            .iter()
                            .enumerate()
                            .map(move |(inner_idx, ixn)| (outer_idx, inner_idx, ixn))
                    })
                    .find_map(|(outer_idx, inner_idx, ixn)| {
                        match ixn {
                            UiInstruction::Compiled(ixn) => {
                                let ixn_prog_id = txn.message.static_account_keys()
                                    [ixn.program_id_index as usize];
                                ixn_prog_id == *program_id
                            }
                            UiInstruction::Parsed(ixn) => {
                                let pubkey = Pubkey::from_str(match &ixn {
                                    UiParsedInstruction::Parsed(ixn) => &ixn.program_id,
                                    UiParsedInstruction::PartiallyDecoded(ixn) => &ixn.program_id,
                                })
                                .expect("Invalid public key in instruction");
                                pubkey == *program_id
                            }
                        }
                        .then_some(
                            SealevelTxnIxnLocation::InnerInstruction(
                                outer_idx.into(),
                                inner_idx.into(),
                            ),
                        )
                    })
            }
            SealevelTxn::Json(txn) => match &txn.message {
                UiMessage::Parsed(msg) => {
                    let outer_idx = msg.instructions.iter().enumerate().find_map(|(idx, ixn)| {
                        let pubkey = Pubkey::from_str(match ixn {
                            UiInstruction::Compiled(ixn) => {
                                &msg.account_keys[ixn.program_id_index as usize].pubkey
                            }
                            UiInstruction::Parsed(ixn) => match &ixn {
                                UiParsedInstruction::Parsed(ixn) => &ixn.program_id,
                                UiParsedInstruction::PartiallyDecoded(ixn) => &ixn.program_id,
                            },
                        })
                        .expect("Invalid public key in instruction");
                        (&pubkey == program_id).then_some(idx)
                    });
                    if outer_idx.is_some() {
                        return outer_idx.map(SealevelTxnIxnLocation::Instruction);
                    }
                    let inner_ixns = match inner_ixns {
                        Some(inner_ixns) => inner_ixns,
                        None => return None,
                    };
                    inner_ixns
                        .iter()
                        .flat_map(|inner| {
                            let outer_idx = inner.index;
                            inner
                                .instructions
                                .iter()
                                .enumerate()
                                .map(move |(inner_idx, ixn)| (outer_idx, inner_idx, ixn))
                        })
                        .find_map(|(outer_idx, inner_idx, ixn)| {
                            let pubkey = Pubkey::from_str(match ixn {
                                UiInstruction::Compiled(ixn) => {
                                    &msg.account_keys[ixn.program_id_index as usize].pubkey
                                }
                                UiInstruction::Parsed(ixn) => match &ixn {
                                    UiParsedInstruction::Parsed(ixn) => &ixn.program_id,
                                    UiParsedInstruction::PartiallyDecoded(ixn) => &ixn.program_id,
                                },
                            })
                            .expect("Invalid public key in instruction");
                            (pubkey == *program_id).then_some(
                                SealevelTxnIxnLocation::InnerInstruction(
                                    outer_idx.into(),
                                    inner_idx.into(),
                                ),
                            )
                        })
                }
                UiMessage::Raw(msg) => {
                    let outer_idx = msg.instructions.iter().enumerate().find_map(|(idx, ixn)| {
                        let pubkey =
                            Pubkey::from_str(&msg.account_keys[ixn.program_id_index as usize])
                                .expect("Invalid public key in instruction");
                        (&pubkey == program_id).then_some(idx)
                    });
                    if outer_idx.is_some() {
                        return outer_idx.map(SealevelTxnIxnLocation::Instruction);
                    }
                    let inner_ixns = match inner_ixns {
                        Some(inner_ixns) => inner_ixns,
                        None => return None,
                    };
                    inner_ixns
                        .iter()
                        .flat_map(|inner| {
                            let outer_idx = inner.index;
                            inner
                                .instructions
                                .iter()
                                .enumerate()
                                .map(move |(inner_idx, ixn)| (outer_idx, inner_idx, ixn))
                        })
                        .find_map(|(outer_idx, inner_idx, ixn)| {
                            let pubkey = Pubkey::from_str(match ixn {
                                UiInstruction::Compiled(ixn) => {
                                    &msg.account_keys[ixn.program_id_index as usize]
                                }
                                UiInstruction::Parsed(ixn) => match &ixn {
                                    UiParsedInstruction::Parsed(ixn) => &ixn.program_id,
                                    UiParsedInstruction::PartiallyDecoded(ixn) => &ixn.program_id,
                                },
                            })
                            .expect("Invalid public key in instruction");
                            (pubkey == *program_id).then_some(
                                SealevelTxnIxnLocation::InnerInstruction(
                                    outer_idx.into(),
                                    inner_idx.into(),
                                ),
                            )
                        })
                }
            },
        }
    }

    fn account_key_index_for_program_id(&self, program_id: &Pubkey) -> Option<usize> {
        match &self.txn {
            SealevelTxn::Binary(txn) => txn
                .message
                .static_account_keys()
                .iter()
                .enumerate()
                .find_map(|(idx, id)| (id == program_id).then(|| idx)),
            SealevelTxn::Json(txn) => match &txn.message {
                UiMessage::Parsed(msg) => {
                    msg.account_keys
                        .iter()
                        .enumerate()
                        .find_map(|(idx, account)| {
                            let id = Pubkey::from_str(&account.pubkey).unwrap();
                            (id == *program_id).then(|| idx)
                        })
                }
                UiMessage::Raw(msg) => {
                    msg.account_keys
                        .iter()
                        .enumerate()
                        .find_map(|(idx, account)| {
                            let pubkey = Pubkey::from_str(account)
                                .expect("Invalid public key in instruction");
                            (&pubkey == program_id).then_some(idx)
                        })
                }
            },
        }
    }

    fn inner_instruction_data_for(
        &self,
        base_instruction_index: u8,
        inner_instruction_program_id: &Pubkey,
    ) -> Result<Option<(u8, Vec<u8>)>, ChainCommunicationError> {
        let inner_instructions = Option::<&Vec<_>>::from(self.meta.inner_instructions.as_ref())
            .ok_or_else(|| ChainCommunicationError::from_other(SealevelTxnError::MissingMetadata))?
            .iter()
            // FIXME what to do if there are multiple calls to the same inner program?
            .find_map(|inner| (inner.index == base_instruction_index).then(|| &inner.instructions))
            .ok_or_else(|| {
                ChainCommunicationError::from_other(SealevelTxnError::MissingMetadata)
            })?;

        for (idx, ixn) in inner_instructions.iter().enumerate() {
            let (inner_ixn_idx, inner_ixn_data_encoded) = match ixn {
                UiInstruction::Parsed(ixn) => match ixn {
                    UiParsedInstruction::Parsed(_) => unimplemented!(),
                    UiParsedInstruction::PartiallyDecoded(ixn) => {
                        let program_id = Pubkey::from_str(&ixn.program_id)
                            .map_err(ChainCommunicationError::from_other)?;
                        if program_id != *inner_instruction_program_id {
                            continue;
                        }
                        (idx, &ixn.data)
                    }
                },
                UiInstruction::Compiled(ixn) => {
                    match self.account_key_index_for_program_id(inner_instruction_program_id) {
                        Some(idx) => {
                            if idx != usize::from(ixn.program_id_index) {
                                continue;
                            }
                            (idx, &ixn.data)
                        }
                        None => continue,
                    }
                }
            };
            return bs58::decode(&inner_ixn_data_encoded)
                .into_vec()
                .map_err(ChainCommunicationError::from_other)
                .map(|data| Some((inner_ixn_idx.try_into().unwrap(), data)));
        }
        Ok(None)
    }

    fn hash(&self) -> H256 {
        let signature = match &self.txn {
            SealevelTxn::Binary(txn) => txn.signatures[0],
            SealevelTxn::Json(txn) => Signature::from_str(&txn.signatures[0]).unwrap(),
        };
        signature_to_txn_hash(&signature)
    }
}

/// Struct that retrieves event data for a Sealevel Mailbox contract
#[derive(Debug)]
pub struct SealevelMailboxIndexer {
    rpc_client: crate::RpcClientWithDebug,
    mailbox: SealevelMailbox,
    program_id: Pubkey,
    // domain: HyperlaneDomain, // FIXME should probably sanity check domain in messages?
}

impl SealevelMailboxIndexer {
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> ChainResult<Self> {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        // let domain = locator.domain;
        let rpc_client = crate::RpcClientWithDebug::new(conf.url.to_string());
        let mailbox = SealevelMailbox::new(conf, locator, None)?;
        Ok(Self {
            program_id,
            rpc_client,
            mailbox,
            // domain,
        })
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let height = self
            .rpc_client
            .0
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
            .0
            .get_program_accounts_with_config(&self.mailbox.program_id, config)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        println!("get_message_with_nonce matching accounts {:?}", accounts);

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
            .0
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

    fn extract_hyperlane_messages(
        &self,
        slot: u64,
        block: EncodedConfirmedBlock,
    ) -> impl Iterator<Item = (HyperlaneMessage, LogMeta)> {
        trace!("slot={}, block={:#?}", slot, block);
        // This *should* always hold true but not 100% sure so panic if not.
        assert!(slot == block.parent_slot + 1 || (slot == 0 && block.parent_slot == 0));

        let mut messages = Vec::new(); // TODO use lazy iterator not vec
        for (txn_num, txn) in block.transactions.into_iter().enumerate() {
            let txn_decoded = match SealevelTxnWithMeta::from_encoded(txn) {
                Ok(Some(txn)) => {
                    debug!("block={}, txn={} : Found good txn", slot, txn_num); // FIXME remove?
                    txn
                }
                Ok(None) => {
                    debug!(
                        "block={}, txn={} : Found accounts txn, skipping",
                        slot, txn_num
                    ); // FIXME remove?
                    continue;
                }
                Err(err) => {
                    error!("Error in extract_hyperlane_messages {}", err);
                    continue;
                }
            };
            let block_hash: H256 = Hash::from_str(&block.blockhash)
                .expect("Invalid blockhash")
                .to_bytes()
                .into();
            let mailbox_ixn_idx = match txn_decoded.contains_program_at_ixn(&self.program_id) {
                Some(idx) => idx,
                None => continue,
            };
            // FIXME trace! or remove
            error!(
                "block {} txn {} contains {} at instruction {:?}!!!!!!!!!!",
                slot, txn_num, self.program_id, mailbox_ixn_idx,
            );
            error!(
                "block.blockhash={}, txn_decoded={:#?}",
                block.blockhash, txn_decoded
            );

            // FIXME need to ensure that we only process noop cpi call data originating from the
            // mailbox program.

            error!("txn_docoded={:#?}", txn_decoded); // FIXME remove
            let mailbox_ixn_idx = match mailbox_ixn_idx {
                SealevelTxnIxnLocation::Instruction(top_level) => top_level,
                // TODO can shortcut right to the inner here...
                SealevelTxnIxnLocation::InnerInstruction(top_level, _inner) => top_level,
            };

            let spl_noop =
                Pubkey::from_str("GpiNbGLpyroc8dFKPhK55eQhhvWn3XUaXJFp5fk5aXUs").unwrap(); // FIXME
            let (inner_ixn_idx, ixn_data) = match txn_decoded
                .inner_instruction_data_for(mailbox_ixn_idx.try_into().unwrap(), &spl_noop)
            {
                Ok(Some(ixn_data)) => ixn_data,
                Ok(None) => continue,
                Err(err) => {
                    error!("{}", err);
                    continue;
                }
            };

            // FIXME we should check that the noop and mailbox instruction are properl signed so we
            // know they are valid calls.

            // FIXME trace! or remove
            error!("ixn_data={:#?}", ixn_data);
            let message = HyperlaneMessage::read_from(&mut std::io::Cursor::new(ixn_data))
                .expect("Invalid encoded hyperlane message");
            error!("message={:#?}", message);

            let meta = LogMeta {
                address: self.program_id.to_bytes().into(),
                block_number: slot,
                block_hash,
                transaction_hash: txn_decoded.hash(),
                transaction_index: txn_num.try_into().unwrap(),
                // Note: We don't have a log index position in the block since we are using noop
                // CPI, so use the transaction's inner instruction index for noop CPI here.
                log_index: U256::from(inner_ixn_idx),
            };

            messages.push((message, meta));
        }

        messages.into_iter()
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

        // // TODO
        // // Could use this RPC: https://docs.solana.com/developing/clients/jsonrpc-api#getblockswithlimit
        // // BUT... that seems like an inefficient way of getting updates from the mailbox. Why not
        // // either poll the mailbox account data directly or subscribe to updates? See
        // // https://docs.solana.com/developing/clients/jsonrpc-api#getaccountinfo
        // // https://docs.solana.com/developing/clients/jsonrpc-api#accountsubscribe
        // // This would require a change to where we output events however so maybe not worth it.
        // let limit = (to - from).try_into().unwrap();
        // let slots = self
        //     .rpc_client
        //     .0
        //     .get_blocks_with_limit_and_commitment(from.into(), limit, CommitmentConfig::finalized())
        //     .await
        //     .map_err(ChainCommunicationError::from_other)?;
        // // FIXME need to check that the returned block numbers are contiguous and that we have all
        // // block numbers that we requested.

        // let mut messages = Vec::with_capacity(limit);
        // for slot in slots.into_iter() {
        //     let block = self
        //         .rpc_client
        //         .0
        //         .get_block(slot)
        //         .await
        //         .map_err(ChainCommunicationError::from_other)?;
        //     messages.extend(self.extract_hyperlane_messages(slot, block));
        // }
        // Ok(messages)

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
        pub auth_bump_seed: u8,
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
                auth_bump_seed: 0,
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
        pub auth_bump_seed: u8,
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
        pub auth_bump_seed: u8,
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
