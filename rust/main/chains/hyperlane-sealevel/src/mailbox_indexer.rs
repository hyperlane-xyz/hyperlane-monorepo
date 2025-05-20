// Silence a clippy bug https://github.com/rust-lang/rust-clippy/issues/12281
#![allow(clippy::blocks_in_conditions)]

use std::{ops::RangeInclusive, sync::Arc};

use async_trait::async_trait;
use hyperlane_sealevel_mailbox::{
    accounts::{
        DispatchedMessageAccount, ProcessedMessageAccount, DISPATCHED_MESSAGE_DISCRIMINATOR,
        PROCESSED_MESSAGE_DISCRIMINATOR,
    },
    mailbox_dispatched_message_pda_seeds, mailbox_processed_message_pda_seeds,
};
use solana_sdk::{account::Account, clock::Slot, pubkey::Pubkey};
use tracing::{debug, info, instrument};

use hyperlane_core::{
    config::StrOrIntParseError, ChainCommunicationError, ChainResult, ContractLocator, Decode as _,
    HyperlaneMessage, Indexed, Indexer, LogMeta, Mailbox, ReorgPeriod, SequenceAwareIndexer, H256,
    H512, U256,
};

use crate::account::{search_accounts_by_discriminator, search_and_validate_account};
use crate::fallback::SubmitSealevelRpc;
use crate::log_meta_composer::{
    is_message_delivery_instruction, is_message_dispatch_instruction, LogMetaComposer,
};
use crate::tx_submitter::TransactionSubmitter;
use crate::{ConnectionConf, SealevelMailbox, SealevelProvider};

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
        provider: Arc<SealevelProvider>,
        tx_submitter: Box<dyn TransactionSubmitter>,
        locator: &ContractLocator,
        conf: &ConnectionConf,
        advanced_log_meta: bool,
    ) -> ChainResult<Self> {
        let mailbox = SealevelMailbox::new(provider, tx_submitter, conf, locator, None)?;

        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));

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

    async fn get_dispatched_message_with_nonce(
        &self,
        nonce: u32,
    ) -> ChainResult<(Indexed<HyperlaneMessage>, LogMeta)> {
        let nonce_bytes = nonce.to_le_bytes();
        let unique_dispatched_message_pubkey_offset = 1 + 8 + 4 + 8; // the offset to get the `unique_message_pubkey` field
        let unique_dispatch_message_pubkey_length = 32; // the length of the `unique_message_pubkey` field
        let accounts = search_accounts_by_discriminator(
            &self.mailbox.provider,
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
            .mailbox
            .get_provider()
            .rpc_client()
            .get_account_with_finalized_commitment(valid_message_storage_pda_pubkey)
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
            .rpc_client()
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
            self.mailbox.get_provider(),
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
            .mailbox
            .get_provider()
            .rpc_client()
            .get_account_with_finalized_commitment(valid_message_storage_pda_pubkey)
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
            .rpc_client()
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
        let tip = self.mailbox.get_provider().rpc_client().get_slot().await?;
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

        let tip = self.mailbox.get_provider().rpc_client().get_slot().await?;

        Ok((Some(sequence), tip))
    }
}
