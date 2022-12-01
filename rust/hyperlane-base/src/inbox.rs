use std::sync::Arc;

use async_trait::async_trait;
use ethers::core::types::H256;
use eyre::Result;

use hyperlane_core::{
    db::HyperlaneDB, HyperlaneChain, HyperlaneCommon, HyperlaneContract, Address, ChainCommunicationError,
    Inbox, MessageStatus,
};

/// Caching inbox type.
#[derive(Debug, Clone)]
pub struct CachingInbox {
    inbox: Arc<dyn Inbox>,
    db: HyperlaneDB,
}

impl std::fmt::Display for CachingInbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingInbox {
    /// Instantiate new CachingInbox
    pub fn new(inbox: Arc<dyn Inbox>, db: HyperlaneDB) -> Self {
        Self { inbox, db }
    }

    /// Return handle on inbox object
    pub fn inbox(&self) -> &Arc<dyn Inbox> {
        &self.inbox
    }

    /// Return handle on HyperlaneDB
    pub fn db(&self) -> &HyperlaneDB {
        &self.db
    }
}

#[async_trait]
impl Inbox for CachingInbox {
    fn remote_domain(&self) -> u32 {
        self.inbox.remote_domain()
    }

    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {
        self.inbox.message_status(leaf).await
    }

    fn contract_address(&self) -> Address {
        self.inbox.contract_address()
    }
}

impl HyperlaneChain for CachingInbox {
    fn chain_name(&self) -> &str {
        self.inbox.chain_name()
    }

    fn local_domain(&self) -> u32 {
        self.inbox.local_domain()
    }
}

impl HyperlaneContract for CachingInbox {
    fn address(&self) -> H256 {
        self.inbox.address()
    }
}

#[async_trait]
impl HyperlaneCommon for CachingInbox {
    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        self.inbox.validator_manager().await
    }
}
