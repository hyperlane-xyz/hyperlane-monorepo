use std::ops::RangeInclusive;
use std::{
    collections::HashSet, fmt::Debug, hash::Hash, marker::PhantomData, sync::Arc, time::Duration,
    time::UNIX_EPOCH,
};

use async_trait::async_trait;
use broadcast::BroadcastMpscSender;
use cursors::*;
use derive_new::new;
use eyre::Result;
use hyperlane_core::{
    ContractSyncCursor, CursorAction, HyperlaneDomain, HyperlaneLogStore,
    HyperlaneSequenceAwareIndexerStore, HyperlaneWatermarkedLogStore, Indexer,
    SequenceAwareIndexer,
};
use hyperlane_core::{Indexed, LogMeta, H512};
use prometheus::core::{AtomicI64, AtomicU64, GenericCounter, GenericGauge};
use tokio::sync::mpsc::Receiver as MpscReceiver;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio::time::sleep;
use tracing::{debug, info, instrument, trace, warn};

use crate::settings::IndexSettings;

pub use metrics::ContractSyncMetrics;

/// Broadcast channel utility, with async interface for `send`
pub mod broadcast;
pub(crate) mod cursors;
mod eta_calculator;
mod metrics;

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

/// Enum used to process different indexers in parallel
#[derive(Clone, Debug, PartialEq)]
pub enum ContractSyncMessage {
    /// Message Id from Message Indexer
    MessageTxId(H512),
    /// Range from Watermark Indexer
    QueryRange(RangeInclusive<u32>),
}

impl<T, S, I> ContractSync<T, S, I>
where
    T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
    S: HyperlaneLogStore<T>,
    I: Indexer<T> + 'static,
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
        let liveness_metric = self
            .metrics
            .liveness_metrics
            .with_label_values(&[label, chain_name]);

        let (message_tx, mut message_rx) = mpsc::unbounded_channel();

        let tx_clone = message_tx.clone();
        let _ = tokio::spawn(async move {
            if let Some(tx_id_rx) = opts.tx_id_receiver {
                Self::tx_id_receiver_task(tx_id_rx, tx_clone).await;
            }
        });

        let (fetch_range_tx, fetch_range_rx) = mpsc::unbounded_channel();

        if let Some(cursor) = opts.cursor {
            let cursor = cursor.into();
            let tx_clone = message_tx.clone();
            let _ = tokio::spawn(async move {
                Self::cursor_receiver_task(
                    cursor,
                    fetch_range_rx,
                    tx_clone,
                    &indexed_height_metric,
                )
                .await;
            });
        }

        loop {
            let msg = match message_rx.recv().await {
                Some(msg) => msg,
                None => break,
            };
            tracing::debug!(?msg, "Received contract sync message");

            Self::update_liveness_metric(&liveness_metric);
            match msg {
                ContractSyncMessage::MessageTxId(tx_id) => {
                    let logs = match self.indexer.fetch_logs_by_tx_hash(tx_id).await {
                        Ok(logs) => logs,
                        Err(err) => {
                            warn!(?err, ?tx_id, "Error fetching logs for tx id");
                            continue;
                        }
                    };
                    let logs = self.dedupe_and_store_logs(logs, &stored_logs_metric).await;
                    let num_logs = logs.len() as u64;
                    info!(
                        num_logs,
                        ?tx_id,
                        sequences = ?logs.iter().map(|(log, _)| log.sequence).collect::<Vec<_>>(),
                        "Found log(s) for tx id"
                    );
                }
                ContractSyncMessage::QueryRange(range) => {
                    let logs_and_range = self
                        .fetch_logs_from_range(range.clone(), &stored_logs_metric)
                        .await
                        .map(|logs| (logs, range.clone()));
                    let _ = fetch_range_tx.send(logs_and_range);
                }
            }
        }

        // Although the above loop should never end (unless by panicking),
        // we put log here to make sure that we see when this method returns normally.
        // Hopefully, compiler will not optimise this code out.
        info!(chain = chain_name, label, "contract sync loop exit");
    }

    fn update_liveness_metric(liveness_metric: &GenericGauge<AtomicI64>) {
        liveness_metric.set(
            UNIX_EPOCH
                .elapsed()
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        );
    }

    async fn tx_id_receiver_task(
        mut recv: MpscReceiver<H512>,
        sender: UnboundedSender<ContractSyncMessage>,
    ) {
        loop {
            let tx_id = match recv.recv().await {
                Some(s) => s,
                None => break,
            };
            let _ = sender.send(ContractSyncMessage::MessageTxId(tx_id));
        }
        tracing::error!("Message ID receiver task exited");
    }

    async fn cursor_receiver_task(
        mut cursor: Box<dyn ContractSyncCursor<T>>,
        mut query_complete_rx: mpsc::UnboundedReceiver<
            Option<(Vec<(Indexed<T>, LogMeta)>, RangeInclusive<u32>)>,
        >,
        sender: UnboundedSender<ContractSyncMessage>,
        indexed_height_metric: &GenericGauge<AtomicI64>,
    ) {
        loop {
            indexed_height_metric.set(cursor.latest_queried_block() as i64);
            let (action, _) = match cursor.next_action().await {
                Ok((action, eta)) => (action, eta),
                Err(err) => {
                    warn!(?err, "Error getting next action");
                    sleep(SLEEP_DURATION).await;
                    continue;
                }
            };
            match action {
                CursorAction::Query(range) => {
                    let _ = sender.send(ContractSyncMessage::QueryRange(range.clone()));
                    let resp_res = query_complete_rx.recv().await;
                    if let Some(Some((logs, range))) = resp_res {
                        if let Err(err) = cursor.update(logs, range).await {
                            warn!(?err, "Error updating cursor");
                        };
                    }
                }
                CursorAction::Sleep(duration) => {
                    debug!(
                        cursor = ?cursor,
                        ?duration,
                        "Cursor can't make progress, sleeping",
                    );
                    sleep(duration).await
                }
            }

            // Added so that we confuse compiler that it is an infinite loop
            if false {
                break;
            }
        }
    }

    #[instrument(fields(domain=self.domain().name()), skip(self, stored_logs_metric))]
    async fn fetch_logs_from_range(
        &self,
        range: RangeInclusive<u32>,
        stored_logs_metric: &GenericCounter<AtomicU64>,
    ) -> Option<Vec<(Indexed<T>, LogMeta)>> {
        debug!(?range, "Looking for events in index range");

        let logs = match self.indexer.fetch_logs_in_range(range.clone()).await {
            Ok(logs) => logs,
            Err(err) => {
                warn!(?err, ?range, "Error fetching logs in range");
                sleep(SLEEP_DURATION).await;
                return None;
            }
        };

        let logs = self.dedupe_and_store_logs(logs, stored_logs_metric).await;
        let logs_found = logs.len() as u64;
        info!(
            ?range,
            num_logs = logs_found,
            sequences = ?logs.iter().map(|(log, meta)| IndexedTxIdAndSequence::new(meta.transaction_id, log.sequence)).collect::<Vec<_>>(),
            "Found log(s) in index range"
        );

        if let Some(broadcast_tx) = self.broadcast_sender.as_ref() {
            // If multiple logs occur in the same transaction they'll have the same transaction_id.
            // Deduplicate their txids to avoid doing wasteful queries in txid indexer
            let unique_txids: HashSet<_> =
                logs.iter().map(|(_, meta)| meta.transaction_id).collect();

            for tx_id in unique_txids {
                if let Err(err) = broadcast_tx.send(tx_id).await {
                    trace!(?err, "Error sending txid to receiver");
                }
            }
        }
        Some(logs)
    }

    async fn dedupe_and_store_logs(
        &self,
        logs: Vec<(Indexed<T>, LogMeta)>,
        stored_logs_metric: &GenericCounter<AtomicU64>,
    ) -> Vec<(Indexed<T>, LogMeta)> {
        let deduped_logs = HashSet::<_>::from_iter(logs);
        let logs = Vec::from_iter(deduped_logs);

        // Store deliveries
        let stored = match self.store.store_logs(&logs).await {
            Ok(stored) => stored,
            Err(err) => {
                warn!(?err, "Error storing logs in db");
                Default::default()
            }
        };
        if stored > 0 {
            debug!(
                domain = self.domain.as_ref(),
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
    async fn cursor(
        &self,
        index_settings: IndexSettings,
    ) -> Result<Box<dyn ContractSyncCursor<T>>> {
        let watermark = self.store.retrieve_high_watermark().await.unwrap();
        let index_settings = IndexSettings {
            from: watermark.unwrap_or(index_settings.from),
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

#[cfg(test)]
mod tests {
    use std::time::SystemTime;

    use hyperlane_core::HyperlaneMessage;

    use super::*;

    #[derive(Clone, Debug)]
    struct MockContractSyncCursor {}

    #[async_trait::async_trait]
    impl ContractSyncCursor<HyperlaneMessage> for MockContractSyncCursor {
        async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
            Ok((
                CursorAction::Sleep(Duration::from_secs(30)),
                Duration::from_secs(0),
            ))
        }

        fn latest_queried_block(&self) -> u32 {
            100
        }

        async fn update(
            &mut self,
            _logs: Vec<(Indexed<HyperlaneMessage>, LogMeta)>,
            _range: RangeInclusive<u32>,
        ) -> Result<()> {
            Ok(())
        }
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_sync_unblocked() {
        let indexed_height_metric =
            GenericGauge::new("name", "help").expect("Failed to create GenericGauge");
        let (contract_sync_message_tx, mut contract_sync_message_rx) = mpsc::unbounded_channel();
        let (message_id_tx, message_id_rx) = mpsc::channel(100);

        let contract_sync_message_tx_clone = contract_sync_message_tx.clone();
        // 1. start task to listen to message ids
        let _ = tokio::task::spawn(async move {
            let _ = ContractSync::<
                HyperlaneMessage,
                Arc<dyn HyperlaneWatermarkedLogStore<HyperlaneMessage>>,
                Arc<dyn SequenceAwareIndexer<HyperlaneMessage>>,
            >::tx_id_receiver_task(
                message_id_rx, contract_sync_message_tx_clone
            )
            .await;
        });

        let (_, query_complete_rx) = mpsc::unbounded_channel();

        // 2. start task to listen to watermark cursor
        let cursor = Box::new(MockContractSyncCursor {});
        let contract_sync_message_tx_clone = contract_sync_message_tx.clone();
        let _ = tokio::task::spawn(async move {
            ContractSync::<
                HyperlaneMessage,
                Arc<dyn HyperlaneWatermarkedLogStore<HyperlaneMessage>>,
                Arc<dyn SequenceAwareIndexer<HyperlaneMessage>>,
            >::cursor_receiver_task(
                cursor,
                query_complete_rx,
                contract_sync_message_tx_clone,
                &indexed_height_metric,
            )
            .await;
        });

        let start_time = SystemTime::now();

        // 3. send some message ids and try and process them
        for i in 0..10 {
            let msg_id = H512::from_low_u64_be(i as u64);
            let _ = message_id_tx.send(msg_id.clone()).await;
            let msg = contract_sync_message_rx.recv().await;
            assert_eq!(msg, Some(ContractSyncMessage::MessageTxId(msg_id)));
        }

        // we should be able to process all those messages relatively quickly
        // and not be blocked by cursor sleep
        let elapsed = start_time.elapsed().unwrap();
        println!("Elapsed: {:?}", elapsed);
        assert!(elapsed < Duration::from_secs(2));
    }
}
