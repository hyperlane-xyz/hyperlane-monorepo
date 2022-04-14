use abacus_core::{
    accumulator::merkle::Proof, db::AbacusDB, AbacusCommon, AbacusMessage, ChainCommunicationError,
    Checkpoint, Inbox, MessageStatus, SignedCheckpoint, TxOutcome,
};
use abacus_test::mocks::inbox::MockInboxContract;
use async_trait::async_trait;
use color_eyre::eyre::Result;
use ethers::core::types::H256;

use abacus_ethereum::EthereumInbox;
use std::str::FromStr;
use std::sync::Arc;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;
use tracing::{info_span, Instrument};

use crate::{AbacusCommonIndexers, ContractSync, ContractSyncMetrics, IndexSettings};

/// Caching inbox type
#[derive(Debug)]
pub struct CachingInbox {
    inbox: Inboxes,
    db: AbacusDB,
    indexer: Arc<AbacusCommonIndexers>,
}

impl std::fmt::Display for CachingInbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingInbox {
    /// Instantiate new CachingInbox
    pub fn new(inbox: Inboxes, db: AbacusDB, indexer: Arc<AbacusCommonIndexers>) -> Self {
        Self { inbox, db, indexer }
    }

    /// Return handle on inbox object
    pub fn inbox(&self) -> Inboxes {
        self.inbox.clone()
    }

    /// Return handle on AbacusDB
    pub fn db(&self) -> AbacusDB {
        self.db.clone()
    }

    /// Spawn a task that syncs the CachingInbox's db with the on-chain event
    /// data
    pub fn sync(
        &self,
        agent_name: String,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("InboxContractSync", self = %self);

        let sync = ContractSync::new(
            agent_name,
            String::from_str(self.inbox.name()).expect("!string"),
            self.db.clone(),
            self.indexer.clone(),
            index_settings,
            metrics,
        );

        tokio::spawn(async move {
            let _ = sync.sync_checkpoints().await?;
            Ok(())
        })
        .instrument(span)
    }
}

#[async_trait]
impl Inbox for CachingInbox {
    async fn remote_domain(&self) -> Result<u32, ChainCommunicationError> {
        self.inbox.remote_domain().await
    }

    /// Process a message
    async fn process(
        &self,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        self.inbox.process(message, proof).await
    }

    async fn message_status(&self, leaf: H256) -> Result<MessageStatus, ChainCommunicationError> {
        self.inbox.message_status(leaf).await
    }

    async fn submit_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpoint,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        self.inbox.submit_checkpoint(signed_checkpoint).await
    }
}

#[async_trait]
impl AbacusCommon for CachingInbox {
    fn name(&self) -> &str {
        self.inbox.name()
    }

    fn local_domain(&self) -> u32 {
        self.inbox.local_domain()
    }

    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        self.inbox.status(txid).await
    }

    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        self.inbox.validator_manager().await
    }

    async fn checkpointed_root(&self) -> Result<H256, ChainCommunicationError> {
        self.inbox.checkpointed_root().await
    }

    async fn latest_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        self.inbox.latest_checkpoint(maybe_lag).await
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

    async fn process(
        &self,
        message: &AbacusMessage,
        proof: &Proof,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.process(message, proof).await,
            InboxVariants::Mock(mock_inbox) => mock_inbox.process(message, proof).await,
            InboxVariants::Other(inbox) => inbox.process(message, proof).await,
        }
    }

    async fn submit_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpoint,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.submit_checkpoint(signed_checkpoint).await,
            InboxVariants::Mock(mock_inbox) => {
                mock_inbox.submit_checkpoint(signed_checkpoint).await
            }
            InboxVariants::Other(inbox) => inbox.submit_checkpoint(signed_checkpoint).await,
        }
    }
}

#[async_trait]
impl AbacusCommon for InboxVariants {
    fn name(&self) -> &str {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.name(),
            InboxVariants::Mock(mock_inbox) => mock_inbox.name(),
            InboxVariants::Other(inbox) => inbox.name(),
        }
    }

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

    async fn checkpointed_root(&self) -> Result<H256, ChainCommunicationError> {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.checkpointed_root().await,
            InboxVariants::Mock(mock_inbox) => mock_inbox.checkpointed_root().await,
            InboxVariants::Other(inbox) => inbox.checkpointed_root().await,
        }
    }

    async fn latest_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        match self {
            InboxVariants::Ethereum(inbox) => inbox.latest_checkpoint(maybe_lag).await,
            InboxVariants::Mock(mock_inbox) => mock_inbox.latest_checkpoint(maybe_lag).await,
            InboxVariants::Other(inbox) => inbox.latest_checkpoint(maybe_lag).await,
        }
    }
}
