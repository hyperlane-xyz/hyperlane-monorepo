use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::core::types::H256;
use eyre::Result;
use futures_util::future::select_all;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Duration};
use tracing::instrument::Instrumented;
use tracing::{info_span, Instrument};

use abacus_core::db::AbacusDB;
use abacus_core::{
    AbacusChain, AbacusCommon, AbacusContract, ChainCommunicationError, Checkpoint, Message,
    Outbox, OutboxEvents, OutboxIndexer, OutboxState, RawCommittedMessage, TxOutcome,
};

use crate::{ContractSync, ContractSyncMetrics, IndexSettings};

/// Caching Outbox type
#[derive(Debug, Clone)]
pub struct CachingOutbox {
    outbox: Arc<dyn Outbox>,
    db: AbacusDB,
    indexer: Arc<dyn OutboxIndexer>,
}

impl std::fmt::Display for CachingOutbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingOutbox {
    /// Instantiate new CachingOutbox
    pub fn new(outbox: Arc<dyn Outbox>, db: AbacusDB, indexer: Arc<dyn OutboxIndexer>) -> Self {
        Self {
            outbox,
            db,
            indexer,
        }
    }

    /// Return handle on outbox object
    pub fn outbox(&self) -> &Arc<dyn Outbox> {
        &self.outbox
    }

    /// Return handle on AbacusDB
    pub fn db(&self) -> &AbacusDB {
        &self.db
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
    async fn state(&self) -> Result<OutboxState, ChainCommunicationError> {
        self.outbox.state().await
    }

    async fn count(&self) -> Result<u32, ChainCommunicationError> {
        self.outbox.count().await
    }

    async fn dispatch(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError> {
        self.outbox.dispatch(message).await
    }

    async fn cache_checkpoint(&self) -> Result<TxOutcome, ChainCommunicationError> {
        self.outbox.cache_checkpoint().await
    }

    async fn latest_cached_root(&self) -> Result<H256, ChainCommunicationError> {
        self.outbox.latest_cached_root().await
    }

    async fn latest_cached_checkpoint(&self) -> Result<Checkpoint, ChainCommunicationError> {
        self.outbox.latest_cached_checkpoint().await
    }

    async fn latest_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        self.outbox.latest_checkpoint(maybe_lag).await
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

impl AbacusChain for CachingOutbox {
    fn chain_name(&self) -> &str {
        self.outbox.chain_name()
    }

    fn local_domain(&self) -> u32 {
        self.outbox.local_domain()
    }
}

impl AbacusContract for CachingOutbox {
    fn address(&self) -> H256 {
        self.outbox.address()
    }
}

#[async_trait]
impl AbacusCommon for CachingOutbox {
    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        self.outbox.status(txid).await
    }

    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        self.outbox.validator_manager().await
    }
}
