use std::fmt::Debug;
use std::num::NonZeroU64;
use std::sync::Arc;

use async_trait::async_trait;
use derive_new::new;
use tokio::task::JoinHandle;
use tracing::{info_span, instrument::Instrumented, Instrument};

use hyperlane_core::{
    ChainResult, Checkpoint, HyperlaneChain, HyperlaneContract, HyperlaneDB, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, Mailbox, MailboxIndexer, TxCostEstimate, TxOutcome, H256,
    U256,
};

use crate::{
    chains::IndexSettings, BackwardMessageSyncCursor, ContractSync, ContractSyncMetrics,
    ForwardMessageSyncCursor, MessageSyncCursorData, RateLimitedSyncBlockRangeCursor,
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

/// The strategy used to sync events
pub enum SyncType {
    /// Forward from some predefined point, indefinitely
    Forward,
    /// Forward and backwards from some predefined point
    MiddleOut,
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
    pub async fn sync_dispatched_messages(
        &self,
        index_settings: IndexSettings,
        sync_type: SyncType,
        metrics: ContractSyncMetrics,
    ) -> eyre::Result<Vec<Instrumented<JoinHandle<eyre::Result<()>>>>> {
        let sync = ContractSync::new(
            self.mailbox.domain().clone(),
            self.db.clone(),
            self.indexer.clone(),
            index_settings.clone(),
            metrics.clone(),
        );
        // TODO: Clean up this mess
        let tasks = match sync_type {
            SyncType::Forward => {
                let forward_data = MessageSyncCursorData::new(
                    sync.clone(),
                    index_settings.from,
                    index_settings.from,
                    0,
                );
                let forward_cursor = Box::new(ForwardMessageSyncCursor::new(forward_data));
                vec![tokio::spawn(
                    async move { sync.sync_dispatched_messages(forward_cursor).await },
                )
                .instrument(info_span!("MailboxContractSync", self = %self))]
            }
            SyncType::MiddleOut => {
                let (count, tip) = self.indexer.fetch_count_at_tip().await.unwrap();
                let forward_data = MessageSyncCursorData::new(sync.clone(), tip, tip, count);
                let forward_cursor = Box::new(ForwardMessageSyncCursor::new(forward_data));
                if count > 0 {
                    let backward_data =
                        MessageSyncCursorData::new(sync.clone(), tip, tip, count.saturating_sub(1));
                    let backward_cursor = Box::new(BackwardMessageSyncCursor::new(backward_data));
                    let backward_sync = sync.clone();
                    vec![
                        tokio::spawn(
                            async move { sync.sync_dispatched_messages(forward_cursor).await },
                        )
                        .instrument(info_span!("MailboxContractSync", self = %self)),
                        tokio::spawn(async move {
                            backward_sync
                                .sync_dispatched_messages(backward_cursor)
                                .await
                        })
                        .instrument(info_span!("MailboxContractSync", self = %self)),
                    ]
                } else {
                    vec![tokio::spawn(async move {
                        sync.sync_dispatched_messages(forward_cursor).await
                    })
                    .instrument(info_span!("MailboxContractSync", self = %self))]
                }
            }
        };
        Ok(tasks)
    }

    /// Spawn a task that syncs the CachingMailbox's db with the on-chain event
    /// data. Currently only supports SyncType::Forward.
    pub async fn sync_delivered_messages(
        &self,
        index_settings: IndexSettings,
        sync_type: SyncType,
        metrics: ContractSyncMetrics,
    ) -> eyre::Result<Vec<Instrumented<JoinHandle<eyre::Result<()>>>>> {
        let sync = ContractSync::new(
            self.mailbox.domain().clone(),
            self.db.clone(),
            self.indexer.clone(),
            index_settings.clone(),
            metrics.clone(),
        );
        // TODO: We shouldn't start at index_settings.from every time!
        match sync_type {
            SyncType::Forward => {
                let forward_cursor = Box::new(
                    RateLimitedSyncBlockRangeCursor::new(
                        self.indexer.clone(),
                        index_settings.chunk_size,
                        index_settings.from,
                    )
                    .await?,
                );
                return Ok(vec![tokio::spawn(async move {
                    sync.sync_delivered_messages(forward_cursor).await
                })
                .instrument(info_span!("MailboxContractSync", self = %self))]);
            }
            SyncType::MiddleOut => {
                panic!("not yet implemented");
            }
        };
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
