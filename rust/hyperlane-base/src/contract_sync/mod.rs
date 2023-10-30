use std::{fmt::Debug, marker::PhantomData, sync::Arc};

use cursor::*;
use derive_new::new;
use hyperlane_core::{
    utils::fmt_sync_time, ContractSyncCursor, CursorAction, HyperlaneDomain, HyperlaneLogStore,
    HyperlaneMessage, HyperlaneMessageStore, HyperlaneWatermarkedLogStore, Indexer,
    SequenceIndexer,
};
pub use metrics::ContractSyncMetrics;
use tokio::time::sleep;
use tracing::{debug, info};

use crate::settings::IndexSettings;

mod cursor;
mod eta_calculator;
mod metrics;

/// Entity that drives the syncing of an agent's db with on-chain data.
/// Extracts chain-specific data (emitted checkpoints, messages, etc) from an
/// `indexer` and fills the agent's db with this data.
#[derive(Debug, new, Clone)]
pub struct ContractSync<T, D: HyperlaneLogStore<T>, I: Indexer<T>> {
    domain: HyperlaneDomain,
    db: D,
    indexer: I,
    metrics: ContractSyncMetrics,
    _phantom: PhantomData<T>,
}

impl<T, D, I> ContractSync<T, D, I>
where
    T: Debug + Send + Sync + Clone + 'static,
    D: HyperlaneLogStore<T> + 'static,
    I: Indexer<T> + Clone + 'static,
{
    /// The domain that this ContractSync is running on
    pub fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// Sync logs and write them to the LogStore
    #[tracing::instrument(name = "ContractSync", fields(domain=self.domain().name()), skip(self, cursor))]
    pub async fn sync(
        &self,
        label: &'static str,
        mut cursor: Box<dyn ContractSyncCursor<T>>,
    ) -> eyre::Result<()> {
        let chain_name = self.domain.as_ref();
        let indexed_height = self
            .metrics
            .indexed_height
            .with_label_values(&[label, chain_name]);
        let stored_logs = self
            .metrics
            .stored_events
            .with_label_values(&[label, chain_name]);

        loop {
            indexed_height.set(cursor.latest_block() as i64);
            let Ok((action, eta)) = cursor.next_action().await else {
                continue;
            };
            match action {
                CursorAction::Query(range) => {
                    debug!(?range, "Looking for for events in index range");

                    let logs = self.indexer.fetch_logs(range.clone()).await?;

                    info!(
                        ?range,
                        num_logs = logs.len(),
                        estimated_time_to_sync = fmt_sync_time(eta),
                        "Found log(s) in index range"
                    );
                    // Store deliveries
                    let stored = self.db.store_logs(&logs).await?;
                    // Report amount of deliveries stored into db
                    stored_logs.inc_by(stored as u64);
                    // Update cursor
                    cursor.update(logs).await?;
                }
                CursorAction::Sleep(duration) => {
                    sleep(duration).await;
                }
            }
        }
    }
}

/// A ContractSync for syncing events using a RateLimitedContractSyncCursor
pub type WatermarkContractSync<T> =
    ContractSync<T, Arc<dyn HyperlaneWatermarkedLogStore<T>>, Arc<dyn SequenceIndexer<T>>>;
impl<T> WatermarkContractSync<T>
where
    T: Debug + Send + Sync + Clone + 'static,
{
    /// Returns a new cursor to be used for syncing events from the indexer based on time
    pub async fn rate_limited_cursor(
        &self,
        index_settings: IndexSettings,
    ) -> Box<dyn ContractSyncCursor<T>> {
        let watermark = self.db.retrieve_high_watermark().await.unwrap();
        let index_settings = IndexSettings {
            from: watermark.unwrap_or(index_settings.from),
            chunk_size: index_settings.chunk_size,
            mode: index_settings.mode,
        };
        Box::new(
            RateLimitedContractSyncCursor::new(
                Arc::new(self.indexer.clone()),
                self.db.clone(),
                index_settings.chunk_size,
                index_settings.from,
                index_settings.mode,
            )
            .await
            .unwrap(),
        )
    }
}

/// A ContractSync for syncing messages using a MessageSyncCursor
pub type MessageContractSync = ContractSync<
    HyperlaneMessage,
    Arc<dyn HyperlaneMessageStore>,
    Arc<dyn SequenceIndexer<HyperlaneMessage>>,
>;
impl MessageContractSync {
    /// Returns a new cursor to be used for syncing dispatched messages from the indexer
    pub async fn forward_message_sync_cursor(
        &self,
        index_settings: IndexSettings,
        next_nonce: u32,
    ) -> Box<dyn ContractSyncCursor<HyperlaneMessage>> {
        Box::new(ForwardMessageSyncCursor::new(
            self.indexer.clone(),
            self.db.clone(),
            index_settings.chunk_size,
            index_settings.from,
            index_settings.from,
            index_settings.mode,
            next_nonce,
        ))
    }

    /// Returns a new cursor to be used for syncing dispatched messages from the indexer
    pub async fn forward_backward_message_sync_cursor(
        &self,
        index_settings: IndexSettings,
    ) -> Box<dyn ContractSyncCursor<HyperlaneMessage>> {
        Box::new(
            ForwardBackwardMessageSyncCursor::new(
                self.indexer.clone(),
                self.db.clone(),
                index_settings.chunk_size,
                index_settings.mode,
            )
            .await
            .unwrap(),
        )
    }
}
