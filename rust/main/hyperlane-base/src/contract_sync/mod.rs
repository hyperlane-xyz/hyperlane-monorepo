use std::{
    collections::HashSet, fmt::Debug, hash::Hash, marker::PhantomData, sync::Arc, time::Duration,
    time::UNIX_EPOCH,
};

use async_trait::async_trait;
use broadcast::BroadcastMpscSender;
use cursors::*;
use derive_new::new;
use eyre::Result;
use prometheus::core::{AtomicI64, AtomicU64, GenericCounter, GenericGauge};
use tokio::sync::{mpsc::Receiver as MpscReceiver, Mutex};
use tokio::time::sleep;
use tracing::{debug, info, instrument, trace, warn};

use hyperlane_core::{
    utils::fmt_sync_time, ContractSyncCursor, CursorAction, HyperlaneDomain, HyperlaneLogStore,
    HyperlaneSequenceAwareIndexerStore, HyperlaneWatermarkedLogStore, Indexer,
    SequenceAwareIndexer,
};
use hyperlane_core::{Indexed, LogMeta, H512};

use crate::settings::IndexSettings;

/// Broadcast channel utility, with async interface for `send`
pub mod broadcast;
/// Cursor types
pub mod cursors;
mod eta_calculator;
mod metrics;

pub use metrics::ContractSyncMetrics;

use cursors::ForwardBackwardSequenceAwareSyncCursor;

const SLEEP_DURATION: Duration = Duration::from_secs(5);

#[derive(Debug, derive_new::new)]
#[allow(dead_code)]
/// Utility struct for pretty-printing indexed items.
struct IndexedTxIdAndSequence {
    tx_id: H512,
    sequence: Option<u32>,
}

/// Entity that drives the syncing of an agent's db with on-chain data.
/// Extracts chain-specific data (emitted checkpoints, messages, etc) from an
/// `indexer` and fills the agent's db with this data.
#[derive(Debug)]
pub struct ContractSync<T: Indexable, S: HyperlaneLogStore<T>, I: Indexer<T>> {
    domain: HyperlaneDomain,
    store: S,
    indexer: I,
    metrics: ContractSyncMetrics,
    broadcast_sender: Option<BroadcastMpscSender<H512>>,
    _phantom: PhantomData<T>,
}

impl<T: Indexable, S: HyperlaneLogStore<T>, I: Indexer<T>> ContractSync<T, S, I> {
    /// Create a new ContractSync
    pub fn new(
        domain: HyperlaneDomain,
        store: S,
        indexer: I,
        metrics: ContractSyncMetrics,
        broadcast_sender_enabled: bool,
    ) -> Self {
        let broadcast_sender = if broadcast_sender_enabled {
            T::broadcast_channel_size().map(BroadcastMpscSender::new)
        } else {
            None
        };
        Self {
            domain,
            store,
            indexer,
            metrics,
            broadcast_sender,
            _phantom: PhantomData,
        }
    }
}

impl<T, S, I> ContractSync<T, S, I>
where
    T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
    S: HyperlaneLogStore<T> + Clone + 'static,
    I: Indexer<T> + Clone + 'static,
{
    /// The domain that this ContractSync is running on
    pub fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn get_broadcaster(&self) -> Option<BroadcastMpscSender<H512>> {
        self.broadcast_sender.clone()
    }

    /// Sync logs and write them to the LogStore
    #[instrument(name = "ContractSync", fields(domain=self.domain().name()), skip(self, opts))]
    pub async fn sync(&self, label: &'static str, opts: SyncOptions<T>) {
        let chain_name = self.domain.as_ref();
        let indexed_height_metric = self
            .metrics
            .indexed_height
            .with_label_values(&[label, chain_name]);
        let stored_logs_metric = self
            .metrics
            .stored_events
            .with_label_values(&[label, chain_name]);

        // need to put this behind an Arc Mutex because we might
        // index the same event twice now. Which causes e2e to fail
        let shared_store = Arc::new(Mutex::new(self.store.clone()));

        // transaction id task for fetching events via transaction id
        let tx_id_task = match opts.tx_id_receiver {
            Some(rx) => {
                let liveness_metric = self.metrics.liveness_metrics.with_label_values(&[
                    label,
                    chain_name,
                    "tx_id_task",
                ]);
                let domain_clone = self.domain.clone();
                let indexer_clone = self.indexer.clone();
                let store_clone = shared_store.clone();
                let stored_logs_metric = stored_logs_metric.clone();
                tokio::task::spawn(async move {
                    Self::tx_id_indexer_task(
                        domain_clone,
                        indexer_clone,
                        store_clone,
                        rx,
                        stored_logs_metric,
                        liveness_metric,
                    )
                    .await;
                })
            }
            None => tokio::task::spawn(async {}),
        };

        // cursor task for fetching events via range querying
        let cursor_task = match opts.cursor {
            Some(cursor) => {
                let liveness_metric = self.metrics.liveness_metrics.with_label_values(&[
                    label,
                    chain_name,
                    "cursor_task",
                ]);
                let domain_clone = self.domain.clone();
                let indexer_clone = self.indexer.clone();
                let store_clone = shared_store.clone();
                let broadcast_sender = self.broadcast_sender.clone();

                let stored_logs_metric = stored_logs_metric.clone();

                tokio::task::spawn(async {
                    Self::cursor_indexer_task(
                        domain_clone,
                        indexer_clone,
                        store_clone,
                        cursor,
                        broadcast_sender,
                        stored_logs_metric,
                        indexed_height_metric,
                        liveness_metric,
                    )
                    .await;
                })
            }
            None => tokio::task::spawn(async {}),
        };

        let res = tokio::join!(tx_id_task, cursor_task);

        // we should never reach this because the 2 tasks should never end
        tracing::error!(chain = chain_name, label, ?res, "contract sync loop exit");
    }

    fn update_liveness_metric(liveness_metric: &GenericGauge<AtomicI64>) {
        liveness_metric.set(
            UNIX_EPOCH
                .elapsed()
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        );
    }

    #[instrument(fields(domain=domain.name()), skip(indexer, store, recv, stored_logs_metric, liveness_metric))]
    async fn tx_id_indexer_task(
        domain: HyperlaneDomain,
        indexer: I,
        store: Arc<Mutex<S>>,
        mut recv: MpscReceiver<H512>,
        stored_logs_metric: GenericCounter<AtomicU64>,
        liveness_metric: GenericGauge<AtomicI64>,
    ) {
        loop {
            Self::update_liveness_metric(&liveness_metric);
            let tx_id = match recv.recv().await {
                Some(tx_id) => tx_id,
                None => {
                    tracing::error!("Error: channel has closed");
                    break;
                }
            };

            let logs = match indexer.fetch_logs_by_tx_hash(tx_id).await {
                Ok(logs) => logs,
                Err(err) => {
                    warn!(?err, ?tx_id, "Error fetching logs for tx id");
                    continue;
                }
            };

            let logs = {
                let store = store.lock().await;
                Self::dedupe_and_store_logs(&domain, &store, logs, &stored_logs_metric).await
            };
            let num_logs = logs.len() as u64;
            info!(
                num_logs,
                ?tx_id,
                sequences = ?logs.iter().map(|(log, _)| log.sequence).collect::<Vec<_>>(),
                pending_ids = ?recv.len(),
                "Found log(s) for tx id"
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn cursor_indexer_task(
        domain: HyperlaneDomain,
        indexer: I,
        store: Arc<Mutex<S>>,
        mut cursor: Box<dyn ContractSyncCursor<T>>,
        broadcast_sender: Option<BroadcastMpscSender<H512>>,
        stored_logs_metric: GenericCounter<AtomicU64>,
        indexed_height_metric: GenericGauge<AtomicI64>,
        liveness_metric: GenericGauge<AtomicI64>,
    ) {
        tracing::info_span!("cursor_indexer_task", domain = domain.name());
        loop {
            Self::update_liveness_metric(&liveness_metric);
            indexed_height_metric.set(cursor.latest_queried_block() as i64);

            let (action, eta) = match cursor.next_action().await {
                Ok((action, eta)) => (action, eta),
                Err(err) => {
                    warn!(?err, "Error getting next action");
                    sleep(SLEEP_DURATION).await;
                    continue;
                }
            };

            let range = match action {
                CursorAction::Sleep(duration) => {
                    trace!(
                        cursor = ?cursor,
                        sleep_duration = ?duration,
                        "Cursor can't make progress, sleeping",
                    );
                    sleep(duration).await;
                    continue;
                }
                CursorAction::Query(range) => range,
            };
            trace!(?range, "Looking for events in index range");

            let logs = match indexer.fetch_logs_in_range(range.clone()).await {
                Ok(logs) => logs,
                Err(err) => {
                    warn!(?err, ?range, "Error fetching logs in range");
                    sleep(SLEEP_DURATION).await;
                    continue;
                }
            };

            let logs = {
                let store = store.lock().await;
                Self::dedupe_and_store_logs(&domain, &store, logs, &stored_logs_metric).await
            };
            let logs_found = logs.len() as u64;
            info!(
                ?range,
                num_logs = logs_found,
                estimated_time_to_sync = fmt_sync_time(eta),
                sequences = ?logs.iter().map(|(log, meta)| IndexedTxIdAndSequence::new(meta.transaction_id, log.sequence)).collect::<Vec<_>>(),
                cursor = ?cursor,
                "Found log(s) in index range"
            );

            if let Some(tx) = broadcast_sender.as_ref() {
                // If multiple logs occur in the same transaction they'll have the same transaction_id.
                // Deduplicate their txids to avoid doing wasteful queries in txid indexer
                let unique_txids: HashSet<_> =
                    logs.iter().map(|(_, meta)| meta.transaction_id).collect();

                for tx_id in unique_txids {
                    if let Err(err) = tx.send(tx_id).await {
                        trace!(?err, "Error sending txid to receiver");
                    }
                }
            }

            // Update cursor
            if let Err(err) = cursor.update(logs, range).await {
                warn!(?err, "Error updating cursor");
            };
        }
    }

    async fn dedupe_and_store_logs(
        domain: &HyperlaneDomain,
        store: &S,
        logs: Vec<(Indexed<T>, LogMeta)>,
        stored_logs_metric: &GenericCounter<AtomicU64>,
    ) -> Vec<(Indexed<T>, LogMeta)> {
        let deduped_logs = HashSet::<_>::from_iter(logs);
        let logs = Vec::from_iter(deduped_logs);

        // Store deliveries
        let stored = match store.store_logs(&logs).await {
            Ok(stored) => stored,
            Err(err) => {
                warn!(?err, "Error storing logs in db");
                Default::default()
            }
        };
        if stored > 0 {
            debug!(
                domain = domain.name(),
                count = stored,
                sequences = ?logs.iter().map(|(log, _)| log.sequence).collect::<Vec<_>>(),
                "Stored logs in db",
            );
        }
        // Report amount of deliveries stored into db
        stored_logs_metric.inc_by(stored as u64);
        logs
    }
}

/// A ContractSync for syncing events using a SequenceAwareIndexer
pub type SequenceAwareContractSync<T, U> = ContractSync<T, U, Arc<dyn SequenceAwareIndexer<T>>>;

/// Log store for the watermark cursor
pub type WatermarkLogStore<T> = Arc<dyn HyperlaneWatermarkedLogStore<T>>;

/// A ContractSync for syncing events using a RateLimitedContractSyncCursor
pub type WatermarkContractSync<T> =
    SequenceAwareContractSync<T, Arc<dyn HyperlaneWatermarkedLogStore<T>>>;

/// Abstraction over a contract syncer that can also be converted into a cursor
#[async_trait]
pub trait ContractSyncer<T>: Send + Sync {
    /// Returns a new cursor to be used for syncing events from the indexer
    async fn cursor(&self, index_settings: IndexSettings)
        -> Result<Box<dyn ContractSyncCursor<T>>>;

    /// Syncs events from the indexer using the provided cursor
    async fn sync(&self, label: &'static str, opts: SyncOptions<T>);

    /// The domain of this syncer
    fn domain(&self) -> &HyperlaneDomain;

    /// If this syncer is also a broadcaster, return the channel to receive txids
    fn get_broadcaster(&self) -> Option<BroadcastMpscSender<H512>>;
}

#[derive(new)]
/// Options for syncing events
pub struct SyncOptions<T> {
    // Keep as optional fields for now to run them simultaneously.
    // Might want to refactor into an enum later, where we either index with a cursor or rely on receiving
    // txids from a channel to other indexing tasks
    cursor: Option<Box<dyn ContractSyncCursor<T>>>,
    tx_id_receiver: Option<MpscReceiver<H512>>,
}

impl<T> From<Box<dyn ContractSyncCursor<T>>> for SyncOptions<T> {
    fn from(cursor: Box<dyn ContractSyncCursor<T>>) -> Self {
        Self {
            cursor: Some(cursor),
            tx_id_receiver: None,
        }
    }
}

#[async_trait]
impl<T> ContractSyncer<T> for WatermarkContractSync<T>
where
    T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
{
    /// Returns a new cursor to be used for syncing events from the indexer based on time
    #[instrument(skip_all, fields(domain=%self.domain.name(), index_settings = ?index_settings))]
    async fn cursor(
        &self,
        index_settings: IndexSettings,
    ) -> Result<Box<dyn ContractSyncCursor<T>>> {
        let watermark = self.store.retrieve_high_watermark().await?;
        // Use `index_settings.from` as lowest allowed block height for indexing so that
        // we can configure the cursor to start from a specific block height, if
        // RPC provider does not provide historical blocks.
        // It should be used with care since it can lead to missing events.
        let from = index_settings.from;
        let from = watermark
            .map(|w| if w <= from {
                warn!(
                    ?w,
                    ?from,
                    "Watermark from database is lower than the configured lowest block height, using the configured block height"
                );
                from
            } else { w })
            .unwrap_or(from);
        let index_settings = IndexSettings {
            from,
            chunk_size: index_settings.chunk_size,
            mode: index_settings.mode,
        };
        Ok(Box::new(
            RateLimitedContractSyncCursor::new(
                Arc::new(self.indexer.clone()),
                self.metrics.cursor_metrics.clone(),
                self.domain(),
                self.store.clone(),
                index_settings.chunk_size,
                index_settings.from,
            )
            .await?,
        ))
    }

    async fn sync(&self, label: &'static str, opts: SyncOptions<T>) {
        ContractSync::sync(self, label, opts).await
    }

    fn domain(&self) -> &HyperlaneDomain {
        ContractSync::domain(self)
    }

    fn get_broadcaster(&self) -> Option<BroadcastMpscSender<H512>> {
        ContractSync::get_broadcaster(self)
    }
}

/// Log store for sequence aware cursors
pub type SequenceAwareLogStore<T> = Arc<dyn HyperlaneSequenceAwareIndexerStore<T>>;

/// A ContractSync for syncing messages using a SequenceSyncCursor
pub type SequencedDataContractSync<T> =
    SequenceAwareContractSync<T, Arc<dyn HyperlaneSequenceAwareIndexerStore<T>>>;

#[async_trait]
impl<T> ContractSyncer<T> for SequencedDataContractSync<T>
where
    T: Indexable + Send + Sync + Debug + Clone + Eq + Hash + 'static,
{
    /// Returns a new cursor to be used for syncing dispatched messages from the indexer
    async fn cursor(
        &self,
        index_settings: IndexSettings,
    ) -> Result<Box<dyn ContractSyncCursor<T>>> {
        Ok(Box::new(
            ForwardBackwardSequenceAwareSyncCursor::new(
                self.domain(),
                self.metrics.cursor_metrics.clone(),
                self.indexer.clone(),
                Arc::new(self.store.clone()),
                index_settings.chunk_size,
                index_settings.from,
                index_settings.mode,
            )
            .await?,
        ))
    }

    async fn sync(&self, label: &'static str, opts: SyncOptions<T>) {
        ContractSync::sync(self, label, opts).await;
    }

    fn domain(&self) -> &HyperlaneDomain {
        ContractSync::domain(self)
    }

    fn get_broadcaster(&self) -> Option<BroadcastMpscSender<H512>> {
        ContractSync::get_broadcaster(self)
    }
}
