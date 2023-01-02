use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::future::select_all;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;
use tracing::{info_span, Instrument};

use hyperlane_core::db::HyperlaneDB;
use hyperlane_core::{
    ChainResult, Checkpoint, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    Mailbox, MailboxIndexer, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::chains::IndexSettings;
use crate::{ContractSync, ContractSyncMetrics};

/// Caching Mailbox type
#[derive(Debug, Clone)]
pub struct CachingMailbox {
    mailbox: Arc<dyn Mailbox>,
    db: HyperlaneDB,
    indexer: Arc<dyn MailboxIndexer>,
}

impl std::fmt::Display for CachingMailbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl CachingMailbox {
    /// Instantiate new CachingMailbox
    pub fn new(
        mailbox: Arc<dyn Mailbox>,
        db: HyperlaneDB,
        indexer: Arc<dyn MailboxIndexer>,
    ) -> Self {
        Self {
            mailbox,
            db,
            indexer,
        }
    }

    /// Return handle on mailbox object
    pub fn mailbox(&self) -> &Arc<dyn Mailbox> {
        &self.mailbox
    }

    /// Return handle on HyperlaneDB
    pub fn db(&self) -> &HyperlaneDB {
        &self.db
    }

    /// Spawn a task that syncs the CachingMailbox's db with the on-chain event
    /// data
    pub fn sync(
        &self,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let span = info_span!("MailboxContractSync", self = %self);

        let sync = ContractSync::new(
            self.mailbox.domain().clone(),
            self.db.clone(),
            self.indexer.clone(),
            index_settings,
            metrics,
        );

        tokio::spawn(async move {
            let tasks = vec![sync.sync_dispatched_messages()];

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
impl Mailbox for CachingMailbox {
    fn domain_hash(&self) -> H256 {
        self.mailbox.domain_hash()
    }

    async fn count(&self) -> ChainResult<u32> {
        self.mailbox.count().await
    }

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        self.mailbox.delivered(id).await
    }

    async fn latest_checkpoint(&self, maybe_lag: Option<u64>) -> ChainResult<Checkpoint> {
        self.mailbox.latest_checkpoint(maybe_lag).await
    }

    /// Fetch the current default interchain security module value
    async fn default_ism(&self) -> ChainResult<H256> {
        self.mailbox.default_ism().await
    }

    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        self.mailbox.recipient_ism(recipient).await
    }

    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        self.mailbox.process(message, metadata, tx_gas_limit).await
    }

    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        self.mailbox.process_estimate_costs(message, metadata).await
    }

    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8> {
        self.mailbox.process_calldata(message, metadata)
    }
}

impl HyperlaneChain for CachingMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        self.mailbox.domain()
    }
}

impl HyperlaneContract for CachingMailbox {
    fn address(&self) -> H256 {
        self.mailbox.address()
    }
}
