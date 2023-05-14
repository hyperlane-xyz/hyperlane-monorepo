use std::fmt::Debug;
use std::num::NonZeroU64;
use std::sync::Arc;

use async_trait::async_trait;
use derive_new::new;
use tokio::task::JoinHandle;
use tracing::{info_span, instrument::Instrumented, Instrument};

use hyperlane_core::{
    ChainResult, Checkpoint, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider, Mailbox, MailboxIndexer, TxCostEstimate, TxOutcome, H256, U256, HyperlaneDB,
};

use crate::{
    chains::IndexSettings, BackwardMessageSyncCursor, ContractSync,
    ContractSyncMetrics, ForwardMessageSyncCursor, MessageSyncCursorData,
};

/// Caching Mailbox type
#[derive(Debug, Clone, new)]
pub struct CachingMailbox {
    mailbox: Arc<dyn Mailbox>,
    db: Arc<dyn HyperlaneDB>,
    indexer: Arc<dyn MailboxIndexer>,
}

impl std::fmt::Display for CachingMailbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl CachingMailbox {
    /// Return handle on mailbox object
    pub fn mailbox(&self) -> &Arc<dyn Mailbox> {
        &self.mailbox
    }

    /// Return handle on HyperlaneDB
    pub fn db(&self) -> &Arc<dyn HyperlaneDB> {
        &self.db
    }

    /// Spawn two tasks that syncs the CachingMailbox's db with the on-chain event
    /// data. One goes forward from the current tip indefinitely, the other goes backwards from
    /// the current tip until the message with nonce 0 has been synced.
    pub async fn sync(
        &self,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> ChainResult<Vec<Instrumented<JoinHandle<eyre::Result<()>>>>> {
        let (count, tip) = self.indexer.fetch_count_at_tip().await?;
        let task_count = if count > 0 { 2 } else { 1 };
        let mut tasks = Vec::with_capacity(task_count);
        if count > 0 {
            // TODO: Can I share/clone these syncs?
            let backward_sync = ContractSync::new(
                self.mailbox.domain().clone(),
                self.db.clone(),
                self.indexer.clone(),
                index_settings.clone(),
                metrics.clone(),
            );
            // TODO: Forward and backward data are nearly identical, can I break
            // next_nonce out so that they can be shared?
            let backward_data = MessageSyncCursorData::new(
                self.indexer.clone(),
                self.db.clone(),
                index_settings.chunk_size,
                tip,
                tip,
                count.saturating_sub(1),
            );
            let backward_cursor = Box::new(BackwardMessageSyncCursor::new(backward_data));
            tasks.push(
                tokio::spawn(async move {
                    backward_sync
                        .sync_dispatched_messages(backward_cursor)
                        .await
                })
                .instrument(info_span!("MailboxContractSync", self = %self)),
            );
        }
        let forward_sync = ContractSync::new(
            self.mailbox.domain().clone(),
            self.db.clone(),
            self.indexer.clone(),
            index_settings.clone(),
            metrics,
        );
        let forward_data = MessageSyncCursorData::new(
            self.indexer.clone(),
            self.db.clone(),
            index_settings.chunk_size,
            tip,
            tip,
            count,
        );
        let forward_cursor = Box::new(ForwardMessageSyncCursor::new(forward_data));
        tasks.push(
            tokio::spawn(
                async move { forward_sync.sync_dispatched_messages(forward_cursor).await },
            )
            .instrument(info_span!("MailboxContractSync", self = %self)),
        );
        Ok(tasks)
    }
}

#[async_trait]
impl Mailbox for CachingMailbox {
    fn domain_hash(&self) -> H256 {
        self.mailbox.domain_hash()
    }

    async fn count(&self, maybe_lag: Option<NonZeroU64>) -> ChainResult<u32> {
        self.mailbox.count(maybe_lag).await
    }

    /// Fetch the status of a message
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        self.mailbox.delivered(id).await
    }

    async fn latest_checkpoint(&self, maybe_lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
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

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.mailbox.provider()
    }
}

impl HyperlaneContract for CachingMailbox {
    fn address(&self) -> H256 {
        self.mailbox.address()
    }
}
