#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::fmt::{self, Debug, Display};
use std::{error::Error as StdError, sync::Arc};

use async_trait::async_trait;
use ethers::prelude::*;
use eyre::Result;
use tracing::instrument;

use abacus_core::{
    AbacusAbi, AbacusChain, AbacusCommon, AbacusContract, Address, ChainCommunicationError,
    ContractLocator, Inbox, InboxIndexer, Indexer, MessageStatus, TxOutcome,
};

use crate::contracts::inbox::{Inbox as EthereumInboxInternal, INBOX_ABI};
use crate::trait_builder::MakeableWithProvider;

impl<M> Display for EthereumInboxInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct InboxBuilder {}

#[async_trait]
impl MakeableWithProvider for InboxBuilder {
    type Output = Box<dyn Inbox>;

    async fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumInbox::new(Arc::new(provider), locator).await)
    }
}

pub struct InboxIndexerBuilder {
    pub finality_blocks: u32,
}

#[async_trait]
impl MakeableWithProvider for InboxIndexerBuilder {
    type Output = Box<dyn InboxIndexer>;

    async fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumInboxIndexer::new(
            Arc::new(provider),
            locator,
            self.finality_blocks,
        ))
    }
}

#[derive(Debug)]
pub struct EthereumInboxIndexer<M>
where
    M: Middleware,
{
    contract: Arc<EthereumInboxInternal<M>>,
    provider: Arc<M>,
    finality_blocks: u32,
}

impl<M> EthereumInboxIndexer<M>
where
    M: Middleware + 'static,
{
    pub fn new(provider: Arc<M>, locator: &ContractLocator, finality_blocks: u32) -> Self {
        let contract = Arc::new(EthereumInboxInternal::new(
            &locator.address,
            provider.clone(),
        ));
        Self {
            contract,
            provider,
            finality_blocks,
        }
    }
}

#[async_trait]
impl<M> Indexer for EthereumInboxIndexer<M>
where
    M: Middleware + 'static,
{
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
impl<M> InboxIndexer for EthereumInboxIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn fetch_processed_messages(
        &self,
        from: u32,
        to: u32,
    ) -> Result<Vec<(H256, abacus_core::LogMeta)>> {
        Ok(self
            .contract
            .process_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| (H256::from(event.message_hash), meta.into()))
            .collect())
    }
}

/// A struct that provides access to an Ethereum inbox contract
#[derive(Debug)]
pub struct EthereumInbox<M>
where
    M: Middleware,
{
    contract: Arc<EthereumInboxInternal<M>>,
    remote_domain: u32,
    chain_name: String,
    local_domain: u32,
}

impl<M> EthereumInbox<M>
where
    M: Middleware,
{
    /// Create a reference to a inbox at a specific Ethereum address on some
    /// chain
    pub async fn new(
        provider: Arc<M>,
        ContractLocator {
            chain_name,
            domain,
            address,
        }: &ContractLocator,
    ) -> Self {
        let contract = Arc::new(EthereumInboxInternal::new(address, provider));
        let remote_domain = contract
            .remote_domain()
            .call()
            .await
            .expect("Failed to get inbox's local_domain");
        debug_assert_eq!(
            contract
                .local_domain()
                .call()
                .await
                .expect("Failed to get inbox's remote_domain"),
            *domain
        );
        Self {
            contract,
            remote_domain,
            local_domain: *domain,
            chain_name: chain_name.to_owned(),
        }
    }
}

impl<M> AbacusChain for EthereumInbox<M>
where
    M: Middleware + 'static,
{
    fn chain_name(&self) -> &str {
        &self.chain_name
    }

    fn local_domain(&self) -> u32 {
        self.local_domain
    }
}

impl<M> AbacusContract for EthereumInbox<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> AbacusCommon for EthereumInbox<M>
where
    M: Middleware + 'static,
{
    #[tracing::instrument(err)]
    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        let receipt_opt = self
            .contract
            .client()
            .get_transaction_receipt(txid)
            .await
            .map_err(|e| Box::new(e) as Box<dyn StdError + Send + Sync>)?;

        Ok(receipt_opt.map(Into::into))
    }

    #[tracing::instrument(err)]
    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        Ok(self.contract.validator_manager().call().await?.into())
    }
}

#[async_trait]
impl<M> Inbox for EthereumInbox<M>
where
    M: Middleware + 'static,
{
    fn remote_domain(&self) -> u32 {
        self.remote_domain
    }

    #[tracing::instrument(err)]
    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {
        let status = self.contract.messages(leaf.into()).call().await?;
        Ok(MessageStatus::try_from(status).expect("Bad status from solidity"))
    }

    fn contract_address(&self) -> Address {
        self.contract.address().into()
    }
}

pub struct EthereumInboxAbi;

impl AbacusAbi for EthereumInboxAbi {
    fn fn_map() -> HashMap<Selector, &'static str> {
        super::extract_fn_map(&INBOX_ABI)
    }
}
