use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::core::types::H256;
use ethers::types::U256;
use eyre::Result;
use futures_util::future::select_all;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Duration};
use tracing::instrument::Instrumented;
use tracing::{info_span, Instrument};

use abacus_core::db::AbacusDB;
use abacus_core::{
    AbacusContract, AbacusMessage, ChainCommunicationError, Checkpoint, Mailbox, MailboxEvents,
    MailboxIndexer, RawAbacusMessage, TxCostEstimate, TxOutcome,
};

use crate::chains::IndexSettings;
use crate::{ContractSync, ContractSyncMetrics};

/// Caching Mailbox type
#[derive(Debug, Clone)]
pub struct CachingMailbox {
    mailbox: Arc<dyn Mailbox>,
    db: AbacusDB,
    indexer: Arc<dyn MailboxIndexer>,
}

impl std::fmt::Display for CachingMailbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl CachingMailbox {
    /// Instantiate new CachingMailbox
    pub fn new(mailbox: Arc<dyn Mailbox>, db: AbacusDB, indexer: Arc<dyn MailboxIndexer>) -> Self {
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

    /// Return handle on AbacusDB
    pub fn db(&self) -> &AbacusDB {
        &self.db
    }

    /// Spawn a task that syncs the CachingMailbox's db with the on-chain event
    /// data
    pub fn sync(
        &self,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let span = info_span!("MailboxContractSync", self = %self);

        let sync = ContractSync::new(
            self.mailbox.chain_name().into(),
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
    fn local_domain(&self) -> u32 {
        self.mailbox.local_domain()
    }

    fn local_domain_hash(&self) -> H256 {
        self.mailbox.local_domain_hash()
    }

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> Result<bool, ChainCommunicationError> {
        self.mailbox.delivered(id).await
    }

    /// Get the status of a transaction.
    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        self.mailbox.status(txid).await
    }

    /// Fetch the current default interchain security module value
    async fn default_module(&self) -> Result<H256, ChainCommunicationError> {
        self.mailbox.default_module().await
    }

    async fn count(&self) -> Result<u32, ChainCommunicationError> {
        self.mailbox.count().await
    }

    async fn latest_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        self.mailbox.latest_checkpoint(maybe_lag).await
    }

    async fn process(
        &self,
        message: &AbacusMessage,
        metadata: &Vec<u8>,
        tx_gas_limit: Option<U256>,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        self.mailbox.process(message, metadata, tx_gas_limit).await
    }

    async fn process_estimate_costs(
        &self,
        message: &AbacusMessage,
        metadata: &Vec<u8>,
    ) -> Result<TxCostEstimate> {
        self.mailbox.process_estimate_costs(message, metadata).await
    }

    fn process_calldata(&self, message: &AbacusMessage, metadata: &Vec<u8>) -> Vec<u8> {
        self.mailbox.process_calldata(message, metadata)
    }
}

#[async_trait]
impl MailboxEvents for CachingMailbox {
    #[tracing::instrument(err, skip(self))]
    async fn raw_message_by_id(
        &self,
        id: H256,
    ) -> Result<Option<RawAbacusMessage>, ChainCommunicationError> {
        loop {
            if let Some(message) = self.db.message_by_id(id)? {
                return Ok(Some(message));
            }
            sleep(Duration::from_millis(500)).await;
        }
    }

    async fn id_by_nonce(&self, nonce: usize) -> Result<Option<H256>, ChainCommunicationError> {
        loop {
            if let Some(id) = self.db.message_id_by_nonce(nonce as u32)? {
                return Ok(Some(id));
            }
            sleep(Duration::from_millis(500)).await;
        }
    }
}

impl AbacusContract for CachingMailbox {
    fn chain_name(&self) -> &str {
        self.mailbox.chain_name()
    }

    fn address(&self) -> H256 {
        self.mailbox.address()
    }
}
