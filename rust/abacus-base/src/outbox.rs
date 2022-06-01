use abacus_core::db::AbacusDB;
use abacus_core::{
    AbacusCommon, AbacusContract, ChainCommunicationError, Checkpoint, Message, Outbox,
    OutboxEvents, RawCommittedMessage, State, TxOutcome,
};

use abacus_ethereum::EthereumOutbox;
use abacus_test::mocks::MockOutboxContract;
use async_trait::async_trait;
use ethers::core::types::H256;
use eyre::Result;
use futures_util::future::select_all;
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Duration};
use tracing::{info_span, Instrument};
use tracing::{instrument, instrument::Instrumented};

use crate::{ContractSync, ContractSyncMetrics, IndexSettings, OutboxIndexers};

/// Caching Outbox type
#[derive(Debug)]
pub struct CachingOutbox {
    outbox: Outboxes,
    db: AbacusDB,
    indexer: Arc<OutboxIndexers>,
}

impl std::fmt::Display for CachingOutbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingOutbox {
    /// Instantiate new CachingOutbox
    pub fn new(outbox: Outboxes, db: AbacusDB, indexer: Arc<OutboxIndexers>) -> Self {
        Self {
            outbox,
            db,
            indexer,
        }
    }

    /// Return handle on outbox object
    pub fn outbox(&self) -> Outboxes {
        self.outbox.clone()
    }

    /// Return handle on AbacusDB
    pub fn db(&self) -> AbacusDB {
        self.db.clone()
    }

    /// Spawn a task that syncs the CachingOutbox's db with the on-chain event
    /// data
    pub fn sync(
        &self,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("OutboxContractSync", self = %self);

        let sync = ContractSync::new(
            self.outbox.chain_name().into(),
            self.db.clone(),
            self.indexer.clone(),
            index_settings,
            metrics,
        );

        tokio::spawn(async move {
            let tasks = vec![sync.sync_outbox_messages()];

            let (_, _, remaining) = select_all(tasks).await;
            for task in remaining.into_iter() {
                cancel_task!(task);
            }

            Ok(())
        })
        .instrument(span)
    }
}

#[async_trait]
impl Outbox for CachingOutbox {
    async fn dispatch(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError> {
        self.outbox.dispatch(message).await
    }

    async fn state(&self) -> Result<State, ChainCommunicationError> {
        self.outbox.state().await
    }

    async fn count(&self) -> Result<u32, ChainCommunicationError> {
        self.outbox.count().await
    }

    async fn cache_checkpoint(&self) -> Result<TxOutcome, ChainCommunicationError> {
        self.outbox.cache_checkpoint().await
    }
}

#[async_trait]
impl OutboxEvents for CachingOutbox {
    #[tracing::instrument(err, skip(self))]
    async fn raw_message_by_leaf(
        &self,
        leaf: H256,
    ) -> Result<Option<RawCommittedMessage>, ChainCommunicationError> {
        loop {
            if let Some(message) = self.db.message_by_leaf(leaf)? {
                return Ok(Some(message));
            }
            sleep(Duration::from_millis(500)).await;
        }
    }

    async fn leaf_by_tree_index(
        &self,
        tree_index: usize,
    ) -> Result<Option<H256>, ChainCommunicationError> {
        loop {
            if let Some(leaf) = self.db.leaf_by_leaf_index(tree_index as u32)? {
                return Ok(Some(leaf));
            }
            sleep(Duration::from_millis(500)).await;
        }
    }
}

impl AbacusContract for CachingOutbox {
    fn chain_name(&self) -> &str {
        self.outbox.chain_name()
    }
}

#[async_trait]
impl AbacusCommon for CachingOutbox {
    fn local_domain(&self) -> u32 {
        self.outbox.local_domain()
    }

    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        self.outbox.status(txid).await
    }

    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        self.outbox.validator_manager().await
    }

    async fn latest_cached_root(&self) -> Result<H256, ChainCommunicationError> {
        self.outbox.latest_cached_root().await
    }

    async fn latest_cached_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        self.outbox.latest_cached_checkpoint(maybe_lag).await
    }
}

#[derive(Debug, Clone)]
/// Arc wrapper for OutboxVariants enum
pub struct Outboxes(Arc<OutboxVariants>);

impl From<OutboxVariants> for Outboxes {
    fn from(outboxes: OutboxVariants) -> Self {
        Self(Arc::new(outboxes))
    }
}

impl std::ops::Deref for Outboxes {
    type Target = Arc<OutboxVariants>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::ops::DerefMut for Outboxes {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

/// Outbox type
#[derive(Debug)]
pub enum OutboxVariants {
    /// Ethereum Outbox contract
    Ethereum(Box<dyn Outbox>),
    /// Mock Outbox contract
    Mock(Box<MockOutboxContract>),
    /// Other Outbox variant
    Other(Box<dyn Outbox>),
}

impl OutboxVariants {
    /// Calls checkpoint on mock variant. Should
    /// only be used during tests.
    #[doc(hidden)]
    pub fn checkpoint(&mut self) {
        if let OutboxVariants::Mock(outbox) = self {
            outbox.checkpoint();
        } else {
            panic!("Outbox should be mock variant!");
        }
    }
}

impl<M> From<EthereumOutbox<M>> for Outboxes
where
    M: ethers::providers::Middleware + 'static,
{
    fn from(outbox: EthereumOutbox<M>) -> Self {
        OutboxVariants::Ethereum(Box::new(outbox)).into()
    }
}

impl From<MockOutboxContract> for Outboxes {
    fn from(mock_outbox: MockOutboxContract) -> Self {
        OutboxVariants::Mock(Box::new(mock_outbox)).into()
    }
}

impl From<Box<dyn Outbox>> for Outboxes {
    fn from(outbox: Box<dyn Outbox>) -> Self {
        OutboxVariants::Other(outbox).into()
    }
}

#[async_trait]
impl Outbox for OutboxVariants {
    #[instrument(level = "trace", err)]
    async fn dispatch(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError> {
        match self {
            OutboxVariants::Ethereum(outbox) => outbox.dispatch(message).await,
            OutboxVariants::Mock(mock_outbox) => mock_outbox.dispatch(message).await,
            OutboxVariants::Other(outbox) => outbox.dispatch(message).await,
        }
    }

    async fn state(&self) -> Result<State, ChainCommunicationError> {
        match self {
            OutboxVariants::Ethereum(outbox) => outbox.state().await,
            OutboxVariants::Mock(mock_outbox) => mock_outbox.state().await,
            OutboxVariants::Other(outbox) => outbox.state().await,
        }
    }

    async fn count(&self) -> Result<u32, ChainCommunicationError> {
        match self {
            OutboxVariants::Ethereum(outbox) => outbox.count().await,
            OutboxVariants::Mock(mock_outbox) => mock_outbox.count().await,
            OutboxVariants::Other(outbox) => outbox.count().await,
        }
    }

    async fn cache_checkpoint(&self) -> Result<TxOutcome, ChainCommunicationError> {
        match self {
            OutboxVariants::Ethereum(outbox) => outbox.cache_checkpoint().await,
            OutboxVariants::Mock(mock_outbox) => mock_outbox.cache_checkpoint().await,
            OutboxVariants::Other(outbox) => outbox.cache_checkpoint().await,
        }
    }
}

impl AbacusContract for OutboxVariants {
    fn chain_name(&self) -> &str {
        match self {
            OutboxVariants::Ethereum(outbox) => outbox.chain_name(),
            OutboxVariants::Mock(mock_outbox) => mock_outbox.chain_name(),
            OutboxVariants::Other(outbox) => outbox.chain_name(),
        }
    }
}

#[async_trait]
impl AbacusCommon for OutboxVariants {
    fn local_domain(&self) -> u32 {
        match self {
            OutboxVariants::Ethereum(outbox) => outbox.local_domain(),
            OutboxVariants::Mock(mock_outbox) => mock_outbox.local_domain(),
            OutboxVariants::Other(outbox) => outbox.local_domain(),
        }
    }

    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        match self {
            OutboxVariants::Ethereum(outbox) => outbox.status(txid).await,
            OutboxVariants::Mock(mock_outbox) => mock_outbox.status(txid).await,
            OutboxVariants::Other(outbox) => outbox.status(txid).await,
        }
    }

    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        match self {
            OutboxVariants::Ethereum(outbox) => outbox.validator_manager().await,
            OutboxVariants::Mock(mock_outbox) => mock_outbox.validator_manager().await,
            OutboxVariants::Other(outbox) => outbox.validator_manager().await,
        }
    }

    async fn latest_cached_root(&self) -> Result<H256, ChainCommunicationError> {
        match self {
            OutboxVariants::Ethereum(outbox) => outbox.latest_cached_root().await,
            OutboxVariants::Mock(mock_outbox) => mock_outbox.latest_cached_root().await,
            OutboxVariants::Other(outbox) => outbox.latest_cached_root().await,
        }
    }

    async fn latest_cached_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        match self {
            OutboxVariants::Ethereum(outbox) => outbox.latest_cached_checkpoint(maybe_lag).await,
            OutboxVariants::Mock(mock_outbox) => {
                mock_outbox.latest_cached_checkpoint(maybe_lag).await
            }
            OutboxVariants::Other(outbox) => outbox.latest_cached_checkpoint(maybe_lag).await,
        }
    }
}
