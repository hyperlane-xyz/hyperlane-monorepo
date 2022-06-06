#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::{error::Error as StdError, sync::Arc};

use async_trait::async_trait;
use ethers::contract::abigen;
use ethers::prelude::*;
use eyre::Result;

use abacus_core::{
    AbacusCommon, AbacusContract, ChainCommunicationError, ContractLocator, Inbox, MessageStatus,
    TxOutcome,
};

use crate::trait_builder::MakeableWithProvider;

abigen!(
    EthereumInboxInternal,
    "./chains/abacus-ethereum/abis/Inbox.abi.json",
     methods {
        initialize(address) as initialize_common;
        initialize(uint32, address, bytes32, uint256, uint32) as initialize;
     },
);

impl<M> std::fmt::Display for EthereumInboxInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct InboxBuilder {}

impl MakeableWithProvider for InboxBuilder {
    type Output = Box<dyn Inbox>;

    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumInbox::new(Arc::new(provider), locator))
    }
}

/// A struct that provides access to an Ethereum inbox contract
#[derive(Debug)]
pub struct EthereumInbox<M>
where
    M: Middleware,
{
    contract: Arc<EthereumInboxInternal<M>>,
    domain: u32,
    chain_name: String,
}

impl<M> EthereumInbox<M>
where
    M: Middleware,
{
    /// Create a reference to a inbox at a specific Ethereum address on some
    /// chain
    pub fn new(
        provider: Arc<M>,
        ContractLocator {
            chain_name,
            domain,
            address,
        }: &ContractLocator,
    ) -> Self {
        Self {
            contract: Arc::new(EthereumInboxInternal::new(address, provider)),
            domain: *domain,
            chain_name: chain_name.to_owned(),
        }
    }
}

impl<M> AbacusContract for EthereumInbox<M>
where
    M: Middleware + 'static,
{
    fn chain_name(&self) -> &str {
        &self.chain_name
    }
}

#[async_trait]
impl<M> AbacusCommon for EthereumInbox<M>
where
    M: Middleware + 'static,
{
    fn local_domain(&self) -> u32 {
        self.domain
    }

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
    async fn remote_domain(&self) -> Result<u32, ChainCommunicationError> {
        Ok(self.contract.remote_domain().call().await?)
    }

    #[tracing::instrument(err)]
    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {
        let status = self.contract.messages(leaf.into()).call().await?;
        match status {
            0 => Ok(MessageStatus::None),
            1 => Ok(MessageStatus::Processed),
            _ => panic!("Bad status from solidity"),
        }
    }
}
