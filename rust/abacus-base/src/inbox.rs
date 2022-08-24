use abacus_core::{
    db::AbacusDB, AbacusCommon, AbacusContract, Address, ChainCommunicationError, Inbox,
    MessageStatus, TxOutcome,
};
use abacus_test::mocks::inbox::MockInboxContract;
use async_trait::async_trait;
use ethers::core::types::H256;
use eyre::Result;

use abacus_ethereum::EthereumInbox;
use std::sync::Arc;

/// Caching inbox type
#[derive(Debug)]
pub struct CachingInbox {
    inbox: Inboxes,
    db: AbacusDB,
}

impl std::fmt::Display for CachingInbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingInbox {
    /// Instantiate new CachingInbox
    pub fn new(inbox: Inboxes, db: AbacusDB) -> Self {
        Self { inbox, db }
    }

    /// Return handle on inbox object
    pub fn inbox(&self) -> Inboxes {
        self.inbox.clone()
    }

    /// Return handle on AbacusDB
    pub fn db(&self) -> AbacusDB {
        self.db.clone()
    }
}

#[async_trait]
impl Inbox for CachingInbox {
    async fn remote_domain(&self) -> Result<u32, ChainCommunicationError> {
        self.inbox.remote_domain().await
    }

    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {
        self.inbox.message_status(leaf).await
    }

    fn contract_address(&self) -> Address {
        self.inbox.contract_address()
    }
}

impl AbacusContract for CachingInbox {
    fn chain_name(&self) -> &str {
        self.inbox.chain_name()
    }
}

#[async_trait]
impl AbacusCommon for CachingInbox {
    fn local_domain(&self) -> u32 {
        self.inbox.local_domain()
    }

    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        self.inbox.status(txid).await
    }

    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        self.inbox.validator_manager().await
    }
}

#[derive(Debug, Clone)]
/// Arc wrapper for InboxVariants enum
pub struct Inboxes(Arc<InboxVariants>);

impl From<InboxVariants> for Inboxes {
    fn from(inboxes: InboxVariants) -> Self {
        Self(Arc::new(inboxes))
    }
}

impl std::ops::Deref for Inboxes {
    type Target = Arc<InboxVariants>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for Inboxes {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

/// Inbox type
#[derive(Debug)]
pub enum InboxVariants {
    /// Ethereum inbox contract
    Ethereum(Box<dyn Inbox>),
    /// Mock inbox contract
    Mock(Box<MockInboxContract>),
    /// Other inbox variant
    Other(Box<dyn Inbox>),
}

impl InboxVariants {
    /// Calls checkpoint on mock variant. Should
    /// only be used during tests.
    #[doc(hidden)]
    pub fn checkpoint(&mut self) {
        if let InboxVariants::Mock(inbox) = self {
            inbox.checkpoint();
        } else {
            panic!("Inbox should be mock variant!");
        }
    }
}

impl<M> From<EthereumInbox<M>> for Inboxes
where
    M: ethers::providers::Middleware + 'static,
{
    fn from(inbox: EthereumInbox<M>) -> Self {
        InboxVariants::Ethereum(Box::new(inbox)).into()
    }
}

impl From<MockInboxContract> for Inboxes {
    fn from(inbox: MockInboxContract) -> Self {
        InboxVariants::Mock(Box::new(inbox)).into()
    }
}

impl From<Box<dyn Inbox>> for Inboxes {
    fn from(inbox: Box<dyn Inbox>) -> Self {
        InboxVariants::Other(inbox).into()
    }
}

#[async_trait]
impl Inbox for InboxVariants {
    async fn remote_domain(&self) -> Result<u32, ChainCommunicationError> {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.remote_domain().await,
            InboxVariants::Mock(mock_inbox) => mock_inbox.remote_domain().await,
            InboxVariants::Other(inbox) => inbox.remote_domain().await,
        }
    }

    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.message_status(leaf).await,
            InboxVariants::Mock(mock_inbox) => mock_inbox.message_status(leaf).await,
            InboxVariants::Other(inbox) => inbox.message_status(leaf).await,
        }
    }

    fn contract_address(&self) -> Address {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.contract_address(),
            InboxVariants::Mock(mock_inbox) => mock_inbox.contract_address(),
            InboxVariants::Other(inbox) => inbox.contract_address(),
        }
    }
}

impl AbacusContract for InboxVariants {
    fn chain_name(&self) -> &str {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.chain_name(),
            InboxVariants::Mock(mock_inbox) => mock_inbox.chain_name(),
            InboxVariants::Other(inbox) => inbox.chain_name(),
        }
    }
}

#[async_trait]
impl AbacusCommon for InboxVariants {
    fn local_domain(&self) -> u32 {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.local_domain(),
            InboxVariants::Mock(mock_inbox) => mock_inbox.local_domain(),
            InboxVariants::Other(inbox) => inbox.local_domain(),
        }
    }

    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.status(txid).await,
            InboxVariants::Mock(mock_inbox) => mock_inbox.status(txid).await,
            InboxVariants::Other(inbox) => inbox.status(txid).await,
        }
    }

    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.validator_manager().await,
            InboxVariants::Mock(mock_inbox) => mock_inbox.validator_manager().await,
            InboxVariants::Other(inbox) => inbox.validator_manager().await,
        }
    }
}
