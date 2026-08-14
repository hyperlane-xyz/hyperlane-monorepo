use std::{
    fmt::Debug,
    ops::RangeInclusive,
    sync::Arc,
    time::{Duration, UNIX_EPOCH},
};

use async_trait::async_trait;
use eyre::{eyre, Result};
use prometheus::{
    core::{AtomicI64, AtomicU64},
    core::{GenericCounter, GenericGauge},
    IntCounterVec,
};
use tokio::time::sleep;
use tracing::{debug, info, instrument, warn};

use hyperlane_base::{settings::IndexSettings, ContractSyncMetrics};
use hyperlane_core::{ChainResult, HyperlaneDomain, HyperlaneLogStore, Indexed, Indexer, LogMeta};

use crate::db::BlockCursor;

const SLEEP_DURATION: Duration = Duration::from_secs(5);

#[async_trait]
pub(crate) trait ChainEventHandler: Send + Sync + Debug {
    fn label(&self) -> &'static str;

    async fn fetch_and_store(&self, range: RangeInclusive<u32>) -> Result<u32>;

    async fn finalized_block_number(&self) -> ChainResult<u32>;
}

#[derive(Debug)]
pub(crate) struct TypedChainEventHandler<T, I, S> {
    label: &'static str,
    indexer: I,
    store: S,
    stored_events_metric: GenericCounter<AtomicU64>,
    _phantom: std::marker::PhantomData<T>,
}

impl<T, I, S> TypedChainEventHandler<T, I, S> {
    pub(crate) fn new(
        label: &'static str,
        indexer: I,
        store: S,
        stored_events_metrics: &IntCounterVec,
        chain_name: &str,
    ) -> Self {
        Self {
            label,
            indexer,
            store,
            stored_events_metric: stored_events_metrics.with_label_values(&[label, chain_name]),
            _phantom: std::marker::PhantomData,
        }
    }
}

#[async_trait]
impl<T, I, S> ChainEventHandler for TypedChainEventHandler<T, I, S>
where
    T: Debug + Send + Sync + 'static,
    I: Indexer<T> + Send + Sync + Debug + 'static,
    S: HyperlaneLogStore<T> + Send + Sync + Debug + 'static,
{
    fn label(&self) -> &'static str {
        self.label
    }

    #[instrument(skip_all, fields(label = self.label, range = ?range))]
    async fn fetch_and_store(&self, range: RangeInclusive<u32>) -> Result<u32> {
        let logs = self.indexer.fetch_logs_in_range(range).await?;
        let logs = dedupe_logs(logs);
        let stored = self.store.store_logs(&logs).await?;
        self.stored_events_metric.inc_by(stored.into());
        Ok(stored)
    }

    async fn finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }
}

fn dedupe_logs<T>(logs: Vec<(Indexed<T>, LogMeta)>) -> Vec<(Indexed<T>, LogMeta)> {
    let mut seen = std::collections::HashSet::new();
    logs.into_iter()
        .filter(|(_, meta)| seen.insert(meta.clone()))
        .collect()
}

#[derive(Debug)]
pub(crate) struct SharedChainIndexer {
    domain: HyperlaneDomain,
    cursor: Arc<BlockCursor>,
    chunk_size: u32,
    idle_sleep_duration: Duration,
    handlers: Vec<Arc<dyn ChainEventHandler>>,
    indexed_height_metric: GenericGauge<AtomicI64>,
    liveness_metric: GenericGauge<AtomicI64>,
}

impl SharedChainIndexer {
    pub(crate) fn new(
        domain: HyperlaneDomain,
        cursor: Arc<BlockCursor>,
        index_settings: IndexSettings,
        metrics: Arc<ContractSyncMetrics>,
        handlers: Vec<Arc<dyn ChainEventHandler>>,
    ) -> Result<Self> {
        if handlers.is_empty() {
            return Err(eyre!(
                "shared scraper indexer requires at least one handler"
            ));
        }

        let chain_name = domain.name().to_owned();
        Ok(Self {
            domain,
            cursor,
            chunk_size: index_settings.chunk_size,
            idle_sleep_duration: index_settings.idle_sleep_duration,
            handlers,
            indexed_height_metric: metrics
                .indexed_height
                .with_label_values(&["shared_scraper", &chain_name]),
            liveness_metric: metrics.liveness_metrics.with_label_values(&[
                "shared_scraper",
                &chain_name,
                "cursor_task",
            ]),
        })
    }

    pub(crate) async fn run(self) {
        let handler_labels = self
            .handlers
            .iter()
            .map(|handler| handler.label())
            .collect::<Vec<_>>();
        info!(
            chain = self.domain.name(),
            ?handler_labels,
            "Starting shared scraper indexer"
        );

        loop {
            self.update_liveness_metric();

            let tip = match self.finalized_block_number().await {
                Ok(tip) => tip,
                Err(err) => {
                    warn!(
                        ?err,
                        chain = self.domain.name(),
                        "Failed to fetch finalized tip"
                    );
                    sleep(SLEEP_DURATION).await;
                    continue;
                }
            };

            let from = self.cursor.height().await;
            let Some(from_u32) = u32::try_from(from).ok() else {
                warn!(
                    from,
                    chain = self.domain.name(),
                    "Cursor height exceeds u32 range"
                );
                sleep(SLEEP_DURATION).await;
                continue;
            };

            if from_u32 > tip {
                self.indexed_height_metric.set(i64::from(tip));
                sleep(self.idle_sleep_duration).await;
                continue;
            }

            let chunk_end = from_u32.saturating_add(self.chunk_size.saturating_sub(1));
            let to = chunk_end.min(tip);
            let range = from_u32..=to;

            let total_stored = match self.fetch_and_store_range(range.clone()).await {
                Ok(total_stored) => total_stored,
                Err(err) => {
                    warn!(
                        ?err,
                        ?range,
                        chain = self.domain.name(),
                        "Shared scraper range failed; cursor will not advance"
                    );
                    sleep(SLEEP_DURATION).await;
                    continue;
                }
            };

            self.cursor.update(u64::from(to.saturating_add(1))).await;
            self.indexed_height_metric.set(i64::from(to));
            debug!(
                ?range,
                total_stored,
                chain = self.domain.name(),
                "Shared scraper indexed range"
            );

            if to >= tip {
                sleep(self.idle_sleep_duration).await;
            }
        }
    }

    fn update_liveness_metric(&self) {
        let now = UNIX_EPOCH
            .elapsed()
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or_default();
        self.liveness_metric.set(now);
    }

    async fn finalized_block_number(&self) -> ChainResult<u32> {
        let Some(tip_provider) = self.handlers.first() else {
            return Err(hyperlane_core::ChainCommunicationError::from_other_str(
                "shared scraper indexer has no handlers",
            ));
        };
        tip_provider.finalized_block_number().await
    }

    async fn fetch_and_store_range(&self, range: RangeInclusive<u32>) -> Result<u32> {
        let mut total_stored = 0u32;
        for handler in &self.handlers {
            let stored = handler
                .fetch_and_store(range.clone())
                .await
                .map_err(|err| {
                    eyre!(
                        "failed to fetch/store handler {} in range {:?}: {err}",
                        handler.label(),
                        range
                    )
                })?;
            total_stored = total_stored.saturating_add(stored);
        }
        Ok(total_stored)
    }
}
