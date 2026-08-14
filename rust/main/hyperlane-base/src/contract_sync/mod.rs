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
use tokio::time::{sleep, Instant};
use tracing::{debug, info, instrument, trace, warn, Instrument};

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
const MAX_FETCH_RETRY_BACKOFF: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Default)]
struct FetchRetryBackoff {
    failed_range: Option<std::ops::RangeInclusive<u32>>,
    consecutive_failures: u32,
    retry_at: Option<Instant>,
}

impl FetchRetryBackoff {
    fn ranges_overlap(
        left: &std::ops::RangeInclusive<u32>,
        right: &std::ops::RangeInclusive<u32>,
    ) -> bool {
        left.start() <= right.end() && right.start() <= left.end()
    }

    fn reset(&mut self) {
        self.failed_range = None;
        self.consecutive_failures = 0;
        self.retry_at = None;
    }

    fn remaining_delay(&self, range: &std::ops::RangeInclusive<u32>) -> Option<Duration> {
        if self
            .failed_range
            .as_ref()
            .is_none_or(|failed| !Self::ranges_overlap(failed, range))
        {
            return None;
        }
        self.retry_at
            .and_then(|retry_at| retry_at.checked_duration_since(Instant::now()))
            .filter(|delay| !delay.is_zero())
    }

    fn record_success(&mut self, range: &std::ops::RangeInclusive<u32>) -> bool {
        let recovered = self
            .failed_range
            .as_ref()
            .is_some_and(|failed| Self::ranges_overlap(failed, range));
        if recovered {
            self.reset();
        }
        recovered
    }

    fn record_failure(&mut self, range: std::ops::RangeInclusive<u32>) -> Duration {
        match self.failed_range.take() {
            Some(failed) if Self::ranges_overlap(&failed, &range) => {
                self.failed_range =
                    Some((*failed.start()).min(*range.start())..=(*failed.end()).max(*range.end()));
            }
            _ => {
                self.reset();
                self.failed_range = Some(range);
            }
        }

        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        let exponent = self.consecutive_failures.saturating_sub(1).min(6);
        let delay = SLEEP_DURATION
            .saturating_mul(1_u32 << exponent)
            .min(MAX_FETCH_RETRY_BACKOFF);
        self.retry_at = Instant::now().checked_add(delay);
        delay
    }
}

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
    #[instrument(name = "ContractSync", fields(domain=self.domain().name(), label), skip(self, opts))]
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
        let fetch_retries_metric = self
            .metrics
            .fetch_retries
            .with_label_values(&[label, chain_name]);
        let fetch_backoff_metric = self
            .metrics
            .fetch_backoff_seconds
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

                tokio::task::spawn(
                    async {
                        Self::cursor_indexer_task(
                            domain_clone,
                            indexer_clone,
                            store_clone,
                            cursor,
                            broadcast_sender,
                            stored_logs_metric,
                            indexed_height_metric,
                            liveness_metric,
                            fetch_retries_metric,
                            fetch_backoff_metric,
                        )
                        .await
                    }
                    .instrument(tracing::info_span!(
                        "spawn_cursor_indexer_task",
                        domain = self.domain().name(),
                        label
                    )),
                )
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
            let logs = match logs {
                Ok(logs) => logs,
                Err(err) => {
                    warn!(
                        ?err,
                        ?tx_id,
                        "Error storing logs in db; tx-id task will rely on cursor retry"
                    );
                    sleep(SLEEP_DURATION).await;
                    continue;
                }
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
    #[instrument(fields(domain=domain.name()), skip(indexer, store, cursor, broadcast_sender, stored_logs_metric, indexed_height_metric, liveness_metric, fetch_retries_metric, fetch_backoff_metric))]
    async fn cursor_indexer_task(
        domain: HyperlaneDomain,
        indexer: I,
        store: Arc<Mutex<S>>,
        mut cursor: Box<dyn ContractSyncCursor<T>>,
        broadcast_sender: Option<BroadcastMpscSender<H512>>,
        stored_logs_metric: GenericCounter<AtomicU64>,
        indexed_height_metric: GenericGauge<AtomicI64>,
        liveness_metric: GenericGauge<AtomicI64>,
        fetch_retries_metric: GenericCounter<AtomicU64>,
        fetch_backoff_metric: GenericGauge<AtomicI64>,
    ) {
        let mut fetch_backoff = FetchRetryBackoff::default();
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

            if let Some(remaining_delay) = fetch_backoff.remaining_delay(&range) {
                // Re-check the cursor at the normal polling interval so newly available
                // forward work is not held behind a long backward-range backoff.
                sleep(remaining_delay.min(SLEEP_DURATION)).await;
                continue;
            }

            let logs = match indexer.fetch_logs_in_range(range.clone()).await {
                Ok(logs) => {
                    if fetch_backoff.record_success(&range) {
                        fetch_backoff_metric.set(0);
                    }
                    logs
                }
                Err(err) => {
                    let retry_delay = fetch_backoff.record_failure(range.clone());
                    fetch_retries_metric.inc();
                    fetch_backoff_metric.set(retry_delay.as_secs() as i64);
                    warn!(
                        ?err,
                        ?range,
                        ?retry_delay,
                        consecutive_failures = fetch_backoff.consecutive_failures,
                        "Error fetching logs in range"
                    );
                    continue;
                }
            };

            let logs = {
                let store = store.lock().await;
                Self::dedupe_and_store_logs(&domain, &store, logs, &stored_logs_metric).await
            };
            let logs = match logs {
                Ok(logs) => logs,
                Err(err) => {
                    warn!(
                        ?err,
                        ?range,
                        "Skipping cursor update because logs failed to store"
                    );
                    sleep(SLEEP_DURATION).await;
                    continue;
                }
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
    ) -> Result<Vec<(Indexed<T>, LogMeta)>> {
        let deduped_logs = HashSet::<_>::from_iter(logs);
        let logs = Vec::from_iter(deduped_logs);

        // Store deliveries
        let stored = store.store_logs(&logs).await?;
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
        Ok(logs)
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        ops::RangeInclusive,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc as StdArc,
        },
    };

    use async_trait::async_trait;
    use prometheus::{IntCounter, IntGauge};

    use hyperlane_core::{
        ChainCommunicationError, ChainResult, HyperlaneMessage, Indexer, KnownHyperlaneDomain,
    };

    use super::*;

    #[derive(Clone, Debug, Default)]
    struct MockIndexer {
        logs: Vec<(Indexed<HyperlaneMessage>, LogMeta)>,
    }

    #[async_trait]
    impl Indexer<HyperlaneMessage> for MockIndexer {
        async fn fetch_logs_in_range(
            &self,
            _range: RangeInclusive<u32>,
        ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
            Ok(self.logs.clone())
        }

        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            Err(ChainCommunicationError::from_other_str(
                "mock indexer does not fetch finalized blocks",
            ))
        }
    }

    #[derive(Clone, Debug)]
    struct StoreResult {
        stored: u32,
        error: Option<&'static str>,
        calls: Option<StdArc<AtomicUsize>>,
    }

    #[async_trait]
    impl HyperlaneLogStore<HyperlaneMessage> for StoreResult {
        async fn store_logs(&self, _logs: &[(Indexed<HyperlaneMessage>, LogMeta)]) -> Result<u32> {
            if let Some(calls) = &self.calls {
                calls.fetch_add(1, Ordering::SeqCst);
            }
            match self.error {
                Some(err) => Err(eyre::eyre!(err)),
                None => Ok(self.stored),
            }
        }
    }

    fn test_domain() -> HyperlaneDomain {
        HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum)
    }

    fn stored_logs_metric() -> IntCounter {
        IntCounter::new("test_stored_events", "test stored events")
            .expect("test counter should be valid")
    }

    fn indexed_height_metric() -> IntGauge {
        IntGauge::new("test_indexed_height", "test indexed height")
            .expect("test gauge should be valid")
    }

    fn liveness_metric() -> IntGauge {
        IntGauge::new("test_liveness", "test liveness").expect("test gauge should be valid")
    }

    fn fetch_retries_metric() -> IntCounter {
        IntCounter::new("test_fetch_retries", "test fetch retries")
            .expect("test counter should be valid")
    }

    fn fetch_backoff_metric() -> IntGauge {
        IntGauge::new("test_fetch_backoff", "test fetch backoff")
            .expect("test gauge should be valid")
    }

    fn test_logs() -> Vec<(Indexed<HyperlaneMessage>, LogMeta)> {
        vec![(
            Indexed::new(HyperlaneMessage::default()).with_sequence(0),
            LogMeta::default(),
        )]
    }

    #[tokio::test]
    async fn dedupe_and_store_logs_returns_logs_and_updates_metric_on_success() {
        let metric = stored_logs_metric();

        let logs =
            ContractSync::<HyperlaneMessage, StoreResult, MockIndexer>::dedupe_and_store_logs(
                &test_domain(),
                &StoreResult {
                    stored: 1,
                    error: None,
                    calls: None,
                },
                test_logs(),
                &metric,
            )
            .await
            .expect("store logs should succeed");

        assert_eq!(logs.len(), 1);
        assert_eq!(metric.get(), 1);
    }

    #[tokio::test]
    async fn dedupe_and_store_logs_returns_error_without_updating_metric() {
        let metric = stored_logs_metric();

        let result =
            ContractSync::<HyperlaneMessage, StoreResult, MockIndexer>::dedupe_and_store_logs(
                &test_domain(),
                &StoreResult {
                    stored: 0,
                    error: Some("db unavailable"),
                    calls: None,
                },
                test_logs(),
                &metric,
            )
            .await;

        assert!(result.is_err());
        assert_eq!(metric.get(), 0);
    }

    #[derive(Debug)]
    struct MockCursor {
        updates: StdArc<AtomicUsize>,
    }

    #[async_trait]
    impl ContractSyncCursor<HyperlaneMessage> for MockCursor {
        async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
            Ok((CursorAction::Query(0..=0), Duration::default()))
        }

        fn latest_queried_block(&self) -> u32 {
            0
        }

        async fn update(
            &mut self,
            _logs: Vec<(Indexed<HyperlaneMessage>, LogMeta)>,
            _range: RangeInclusive<u32>,
        ) -> Result<()> {
            self.updates.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn cursor_indexer_task_skips_cursor_update_when_store_errors() {
        let store_calls = StdArc::new(AtomicUsize::new(0));
        let cursor_updates = StdArc::new(AtomicUsize::new(0));
        let store = StoreResult {
            stored: 0,
            error: Some("db unavailable"),
            calls: Some(store_calls.clone()),
        };
        let cursor = MockCursor {
            updates: cursor_updates.clone(),
        };

        let task = tokio::spawn(
            ContractSync::<HyperlaneMessage, StoreResult, MockIndexer>::cursor_indexer_task(
                test_domain(),
                MockIndexer { logs: test_logs() },
                Arc::new(Mutex::new(store)),
                Box::new(cursor),
                None,
                stored_logs_metric(),
                indexed_height_metric(),
                liveness_metric(),
                fetch_retries_metric(),
                fetch_backoff_metric(),
            ),
        );

        for _ in 0..50 {
            if store_calls.load(Ordering::SeqCst) > 0 {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(store_calls.load(Ordering::SeqCst), 1);
        assert_eq!(cursor_updates.load(Ordering::SeqCst), 0);

        task.abort();
        let _ = task.await;
    }

    #[derive(Clone, Debug)]
    struct FailingThenSuccessfulIndexer {
        failures: usize,
        calls: StdArc<AtomicUsize>,
    }

    #[async_trait]
    impl Indexer<HyperlaneMessage> for FailingThenSuccessfulIndexer {
        async fn fetch_logs_in_range(
            &self,
            _range: RangeInclusive<u32>,
        ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            if call < self.failures {
                Err(ChainCommunicationError::from_other_str(
                    "mock range fetch failed",
                ))
            } else {
                Ok(Vec::new())
            }
        }

        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            Err(ChainCommunicationError::from_other_str(
                "mock indexer does not fetch finalized blocks",
            ))
        }
    }

    #[derive(Debug)]
    struct ScriptedCursor {
        ranges: VecDeque<RangeInclusive<u32>>,
        repeat_range: RangeInclusive<u32>,
        updates: StdArc<AtomicUsize>,
    }

    #[async_trait]
    impl ContractSyncCursor<HyperlaneMessage> for ScriptedCursor {
        async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
            if self.updates.load(Ordering::SeqCst) > 0 {
                return Ok((CursorAction::Sleep(Duration::from_secs(60)), Duration::ZERO));
            }
            let range = self
                .ranges
                .pop_front()
                .unwrap_or_else(|| self.repeat_range.clone());
            Ok((CursorAction::Query(range), Duration::ZERO))
        }

        fn latest_queried_block(&self) -> u32 {
            0
        }

        async fn update(
            &mut self,
            _logs: Vec<(Indexed<HyperlaneMessage>, LogMeta)>,
            _range: RangeInclusive<u32>,
        ) -> Result<()> {
            self.updates.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    async fn run_pending_tasks() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_fetch_errors_back_off_without_advancing_cursor() {
        let calls = StdArc::new(AtomicUsize::new(0));
        let updates = StdArc::new(AtomicUsize::new(0));
        let retries = fetch_retries_metric();
        let delay = fetch_backoff_metric();
        let task = tokio::spawn(ContractSync::<
            HyperlaneMessage,
            StoreResult,
            FailingThenSuccessfulIndexer,
        >::cursor_indexer_task(
            test_domain(),
            FailingThenSuccessfulIndexer {
                failures: 3,
                calls: calls.clone(),
            },
            Arc::new(Mutex::new(StoreResult {
                stored: 0,
                error: None,
                calls: None,
            })),
            Box::new(ScriptedCursor {
                ranges: VecDeque::new(),
                repeat_range: 7..=9,
                updates: updates.clone(),
            }),
            None,
            stored_logs_metric(),
            indexed_height_metric(),
            liveness_metric(),
            retries.clone(),
            delay.clone(),
        ));

        run_pending_tasks().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(updates.load(Ordering::SeqCst), 0);
        assert_eq!(retries.get(), 1);
        assert_eq!(delay.get(), 5);

        tokio::time::advance(Duration::from_secs(4)).await;
        run_pending_tasks().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        tokio::time::advance(Duration::from_secs(1)).await;
        run_pending_tasks().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(updates.load(Ordering::SeqCst), 0);
        assert_eq!(delay.get(), 10);

        tokio::time::advance(Duration::from_secs(10)).await;
        run_pending_tasks().await;
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(updates.load(Ordering::SeqCst), 0);
        assert_eq!(delay.get(), 20);

        tokio::time::advance(Duration::from_secs(20)).await;
        run_pending_tasks().await;
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert_eq!(updates.load(Ordering::SeqCst), 1);
        assert_eq!(retries.get(), 3);
        assert_eq!(delay.get(), 0);

        task.abort();
        let _ = task.await;
    }

    #[tokio::test(start_paused = true)]
    async fn changed_range_bypasses_fetch_backoff() {
        let calls = StdArc::new(AtomicUsize::new(0));
        let updates = StdArc::new(AtomicUsize::new(0));
        let retries = fetch_retries_metric();
        let delay = fetch_backoff_metric();
        let task = tokio::spawn(ContractSync::<
            HyperlaneMessage,
            StoreResult,
            FailingThenSuccessfulIndexer,
        >::cursor_indexer_task(
            test_domain(),
            FailingThenSuccessfulIndexer {
                failures: 1,
                calls: calls.clone(),
            },
            Arc::new(Mutex::new(StoreResult {
                stored: 0,
                error: None,
                calls: None,
            })),
            Box::new(ScriptedCursor {
                ranges: VecDeque::from([7..=9, 10..=12]),
                repeat_range: 10..=12,
                updates: updates.clone(),
            }),
            None,
            stored_logs_metric(),
            indexed_height_metric(),
            liveness_metric(),
            retries.clone(),
            delay.clone(),
        ));

        run_pending_tasks().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(updates.load(Ordering::SeqCst), 1);
        assert_eq!(retries.get(), 1);
        assert_eq!(delay.get(), 5);

        task.abort();
        let _ = task.await;
    }

    #[tokio::test(start_paused = true)]
    async fn fetch_backoff_is_exponential_and_bounded() {
        let mut backoff = FetchRetryBackoff::default();
        for expected in [5, 10, 20, 40, 80, 160, 300, 300] {
            let delay = backoff.record_failure(7..=9);
            assert_eq!(delay, Duration::from_secs(expected));
            tokio::time::advance(delay).await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn unrelated_success_does_not_reset_failed_range_backoff() {
        let failed_range = 7..=9;
        let forward_range = 10..=12;
        let mut backoff = FetchRetryBackoff::default();

        assert_eq!(
            backoff.record_failure(failed_range.clone()),
            Duration::from_secs(5)
        );
        assert_eq!(backoff.remaining_delay(&forward_range), None);
        assert!(!backoff.record_success(&forward_range));

        tokio::time::advance(Duration::from_secs(5)).await;
        assert_eq!(
            backoff.record_failure(failed_range.clone()),
            Duration::from_secs(10)
        );
        assert_eq!(backoff.remaining_delay(&forward_range), None);
        assert!(!backoff.record_success(&forward_range));

        tokio::time::advance(Duration::from_secs(10)).await;
        assert_eq!(
            backoff.record_failure(failed_range.clone()),
            Duration::from_secs(20)
        );
        assert!(backoff.record_success(&failed_range));
        assert_eq!(backoff.failed_range, None);
    }

    #[tokio::test(start_paused = true)]
    async fn moving_range_end_preserves_fetch_backoff() {
        let mut backoff = FetchRetryBackoff::default();

        assert_eq!(backoff.record_failure(7..=9), Duration::from_secs(5));
        tokio::time::advance(Duration::from_secs(5)).await;
        assert_eq!(backoff.record_failure(7..=12), Duration::from_secs(10));
        assert_eq!(backoff.failed_range, Some(7..=12));

        tokio::time::advance(Duration::from_secs(10)).await;
        assert_eq!(backoff.record_failure(8..=15), Duration::from_secs(20));
        assert_eq!(backoff.failed_range, Some(7..=15));
        assert!(backoff.record_success(&(10..=20)));
        assert_eq!(backoff.failed_range, None);
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
        Ok(Box::new(
            RateLimitedContractSyncCursor::new(
                Arc::new(self.indexer.clone()),
                self.metrics.cursor_metrics.clone(),
                self.domain(),
                self.store.clone(),
                index_settings.chunk_size,
                index_settings.from,
                watermark,
                index_settings.idle_sleep_duration,
                index_settings.configured_interval,
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
                index_settings.idle_sleep_duration,
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
