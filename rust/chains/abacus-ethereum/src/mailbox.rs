#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::{error::Error as StdError, sync::Arc};

use async_trait::async_trait;
use ethers::prelude::*;
use eyre::Result;
use tracing::instrument;

use abacus_core::{
    AbacusAbi, AbacusContract, AbacusMessage, ChainCommunicationError, Checkpoint, ContractLocator,
    Indexer, LogMeta, Mailbox, MailboxIndexer, RawAbacusMessage, TxOutcome,
};

use crate::contracts::mailbox::{Mailbox as EthereumMailboxInternal, MAILBOX_ABI};
use crate::trait_builder::MakeableWithProvider;
use crate::tx::report_tx;

impl<M> std::fmt::Display for EthereumMailboxInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct MailboxIndexerBuilder {
    pub finality_blocks: u32,
}

impl MakeableWithProvider for MailboxIndexerBuilder {
    type Output = Box<dyn MailboxIndexer>;

    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMailboxIndexer::new(
            Arc::new(provider),
            locator,
            self.finality_blocks,
        ))
    }
}

#[derive(Debug)]
/// Struct that retrieves event data for an Ethereum mailbox
pub struct EthereumMailboxIndexer<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMailboxInternal<M>>,
    provider: Arc<M>,
    finality_blocks: u32,
    mailbox_domain: u32,
}

impl<M> EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create new EthereumMailboxIndexer
    pub fn new(provider: Arc<M>, locator: &ContractLocator, finality_blocks: u32) -> Self {
        let contract = Arc::new(EthereumMailboxInternal::new(
            &locator.address,
            provider.clone(),
        ));
        Self {
            contract,
            provider,
            finality_blocks,
            mailbox_domain: locator.domain,
        }
    }
}

#[async_trait]
impl<M> Indexer for EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn get_finalized_block_number(&self) -> Result<u32> {
        Ok(self
            .provider
            .get_block_number()
            .await?
            .as_u32()
            .saturating_sub(self.finality_blocks))
    }
}

#[async_trait]
impl<M> MailboxIndexer for EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn fetch_sorted_messages(
        &self,
        from: u32,
        to: u32,
    ) -> Result<Vec<(RawAbacusMessage, LogMeta)>> {
        let mut events: Vec<(RawAbacusMessage, LogMeta)> = self
            .contract
            .dispatch_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| {
                (
                    event.message.to_vec(),
                    meta.into(),
                )
            })
            .collect();
        events.sort_by(|a, b| AbacusMessage::from(&a.0).nonce.cmp(&AbacusMessage::from(&b.0).nonce));
        Ok(events)
    }
}

pub struct MailboxBuilder {}

impl MakeableWithProvider for MailboxBuilder {
    type Output = Box<dyn Mailbox>;

    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMailbox::new(Arc::new(provider), locator))
    }
}

/// A reference to an Mailbox contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumMailbox<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMailboxInternal<M>>,
    domain: u32,
    chain_name: String,
    provider: Arc<M>,
}

impl<M> EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumMailboxInternal::new(
                &locator.address,
                provider.clone(),
            )),
            domain: locator.domain,
            chain_name: locator.chain_name.to_owned(),
            provider,
        }
    }
}

impl<M> AbacusContract for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    fn chain_name(&self) -> &str {
        &self.chain_name
    }

    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> Mailbox for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    #[tracing::instrument(err, skip(self))]
    async fn count(&self) -> Result<u32, ChainCommunicationError> {
        Ok(self.contract.count().call().await?.as_u32())
    }

    #[tracing::instrument(err, skip(self))]
    async fn latest_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        let base_call = self.contract.latest_checkpoint();
        let call_with_lag = match maybe_lag {
            Some(lag) => {
                let tip = self
                    .provider
                    .get_block_number()
                    .await
                    .map_err(|x| ChainCommunicationError::CustomError(Box::new(x)))?
                    .as_u64();
                base_call.block(if lag > tip { 0 } else { tip - lag })
            }
            None => base_call,
        };
        let (root, index) = call_with_lag.call().await?;
        Ok(Checkpoint {
            mailbox_domain: self.domain,
            root: root.into(),
            index: index.as_u32(),
        })
    }

    fn local_domain(&self) -> u32 {
        self.domain
    }

    #[tracing::instrument(err, skip(self))]
    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        let receipt_opt = self
            .contract
            .client()
            .get_transaction_receipt(txid)
            .await
            .map_err(|e| Box::new(e) as Box<dyn StdError + Send + Sync>)?;

        Ok(receipt_opt.map(Into::into))
    }

    #[tracing::instrument(err, skip(self))]
    async fn default_module(&self) -> Result<H256, ChainCommunicationError> {
        Ok(self.contract.default_module().call().await?.into())
    }

    #[tracing::instrument(err)]
    async fn delivered(&self, id: H256) -> Result<bool, ChainCommunicationError> {
        Ok(self.contract.delivered(id.into()).call().await?.into())
    }
}

pub struct EthereumMailboxAbi;

impl AbacusAbi for EthereumMailboxAbi {
    fn fn_map() -> HashMap<Selector, &'static str> {
        super::extract_fn_map(&MAILBOX_ABI)
    }
}
