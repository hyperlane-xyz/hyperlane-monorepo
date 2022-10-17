use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;
use ethers::core::types::H256;
use eyre::Result;

use crate::{
    traits::{AbacusCommon, ChainCommunicationError},
    Address, MessageStatus,
};

/// Interface for on-chain inboxes
#[async_trait]
#[auto_impl(Box, Arc)]
pub trait Inbox: AbacusCommon + Send + Sync + Debug {
    /// Return the domain of the inbox's linked outbox
    async fn remote_domain(&self) -> Result<u32, ChainCommunicationError>;

    /// Fetch the status of a message
    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError>;

    /// The on-chain address of the inbox contract.
    fn contract_address(&self) -> Address;
}
