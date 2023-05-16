use std::{marker::PhantomData, sync::Arc};

use derive_new::new;

use cursor::*;
use hyperlane_core::{
    ContractSyncCursor, HyperlaneDB, HyperlaneDomain, HyperlaneMessage, HyperlaneMessageDB,
    Indexer, MessageIndexer,
};
pub use metrics::ContractSyncMetrics;
use std::fmt::Debug;
use tracing::{debug, info};

use crate::chains::IndexSettings;

mod cursor;
mod eta_calculator;
mod metrics;

// Okay, how do I allow
/// Entity that drives the syncing of an agent's db with on-chain data.
/// Extracts chain-specific data (emitted checkpoints, messages, etc) from an
/// `indexer` and fills the agent's db with this data. A CachingMailbox
/// will use a contract sync to spawn syncing tasks to keep the db up-to-date.
#[derive(Debug, new, Clone)]
pub struct ContractSync<T, D: HyperlaneDB<T>, I: Indexer<T>> {
    domain: HyperlaneDomain,
    db: D,
    indexer: I,
    metrics: ContractSyncMetrics,
    // TODO: Why is this necessary?
    blah: PhantomData<T>,
}

impl<T, D, I> ContractSync<T, D, I>
where
    T: Debug + Send + Sync + Clone + 'static,
    D: HyperlaneDB<T> + 'static,
    I: Indexer<T> + Clone + 'static,
{
    /// Returns a new cursor to be used for syncing events from the indexer based on time
    pub async fn rate_limited_cursor(
        &self,
        index_settings: IndexSettings,
    ) -> Box<dyn ContractSyncCursor<T>> {
        Box::new(
            RateLimitedContractSyncCursor::new(
                Arc::new(self.indexer.clone()),
                index_settings.chunk_size,
                index_settings.from,
            )
            .await
            .unwrap(),
        )
    }

    /// Sync logs
    #[tracing::instrument(name = "ContractSync", skip(self, cursor))]
    pub async fn sync(
        &self,
        label: &'static str,
        mut cursor: Box<dyn ContractSyncCursor<T>>,
    ) -> eyre::Result<()> {
        let chain_name = self.domain.as_ref();
        let stored_logs = self
            .metrics
            .stored_events
            .with_label_values(&[label, chain_name]);

        loop {
            let Ok((from, to, _)) = cursor.next_range().await else { continue };
            debug!(from, to, "Looking for for events in block range");

            let logs = self.indexer.fetch_logs(from, to).await?;

            info!(
                from,
                to,
                num_logs = logs.len(),
                "Found log(s) in block range"
            );

            // Store deliveries
            let stored = self.db.store_logs(&logs).await?;
            // Report amount of deliveries stored into db
            stored_logs.inc_by(stored as u64);
            // Update cursor
            cursor.update(logs).await?;
        }
    }
}

impl ContractSync<HyperlaneMessage, Arc<dyn HyperlaneMessageDB>, Arc<dyn MessageIndexer>> {
    /// Returns a new cursor to be used for syncing dispatched messages from the indexer
    pub async fn forward_message_sync_cursor(
        &self,
        index_settings: IndexSettings,
    ) -> Box<dyn ContractSyncCursor<HyperlaneMessage>> {
        let forward_data = MessageSyncCursor::new(
            self.indexer.clone(),
            self.db.clone(),
            index_settings.chunk_size,
            index_settings.from,
            index_settings.from,
            0,
        );
        Box::new(ForwardMessageSyncCursor::new(forward_data))
    }
}
