use std::sync::Arc;

use async_trait::async_trait;
use ethers::core::types::H256;
use eyre::Result;

use abacus_core::{
    db::AbacusDB, AbacusChain, AbacusCommon, AbacusContract, Address, ChainCommunicationError,
    Inbox, MessageStatus, TxOutcome,
};

/// Caching inbox type.
#[derive(Debug, Clone)]
pub struct CachingInbox {
    inbox: Arc<dyn Inbox>,
    db: AbacusDB,
}

impl std::fmt::Display for CachingInbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingInbox {
    /// Instantiate new CachingInbox
    pub fn new(inbox: Arc<dyn Inbox>, db: AbacusDB) -> Self {
        Self { inbox, db }
    }

    /// Return handle on inbox object
    pub fn inbox(&self) -> &Arc<dyn Inbox> {
        &self.inbox
    }

    /// Return handle on AbacusDB
    pub fn db(&self) -> &AbacusDB {
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

impl AbacusChain for CachingInbox {
    fn chain_name(&self) -> &str {
        self.inbox.chain_name()
    }

    fn local_domain(&self) -> u32 {
        self.inbox.local_domain()
    }
}

impl AbacusContract for CachingInbox {
    fn address(&self) -> H256 {
        self.inbox.address()
    }
}

#[async_trait]
impl AbacusCommon for CachingInbox {
    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        self.inbox.status(txid).await
    }

    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        self.inbox.validator_manager().await
    }
}
