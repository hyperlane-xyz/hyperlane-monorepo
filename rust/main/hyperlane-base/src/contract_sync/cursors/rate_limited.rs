use std::{
    fmt::Debug,
    ops::RangeInclusive,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;

use hyperlane_core::{
    ContractSyncCursor, CursorAction, HyperlaneDomain, HyperlaneWatermarkedLogStore, Indexed,
    Indexer, LogMeta,
};

use crate::contract_sync::eta_calculator::SyncerEtaCalculator;

use super::{CursorMetrics, Indexable};

/// Time window for the moving average used in the eta calculator in seconds.
const ETA_TIME_WINDOW: f64 = 2. * 60.;

#[derive(Debug, new)]
pub(crate) struct SyncState {
    chunk_size: u32,
    /// The starting block for the cursor
    start_block: u32,
    /// The next block that should be indexed.
    next_block: u32,
    direction: SyncDirection,
}

impl SyncState {
    async fn get_next_range(&self, tip: u32) -> Result<Option<RangeInclusive<u32>>> {
        // We attempt to index a range of blocks that is as large as possible.
        let range = self.block_range(tip);
        if range.is_empty() {
            return Ok(None);
        }
        Ok(Some(range))
    }

    fn block_range(&self, tip: u32) -> RangeInclusive<u32> {
        let (from, to) = match self.direction {
            SyncDirection::Forward => {
                let from = self.next_block;
                let mut to = from.saturating_add(self.chunk_size);
                to = u32::min(to, tip);
                (from, to)
            }
            SyncDirection::Backward => {
                let to = self.next_block;
                let from = to.saturating_sub(self.chunk_size);
                (from, to)
            }
        };
        from..=to
    }

    fn update_range(&mut self, range: RangeInclusive<u32>) {
        match self.direction {
            SyncDirection::Forward => {
                self.next_block = range.end().saturating_add(1);
            }
            SyncDirection::Backward => {
                self.next_block = range.start().saturating_sub(1);
            }
        }
    }
}

#[allow(dead_code)]
#[derive(Debug)]
pub enum SyncDirection {
    Forward,
    Backward,
}

/// Tool for handling the logic of what the next block range that should be
/// queried is and also handling rate limiting. Rate limiting is automatically
/// performed by `next_action`.
pub(crate) struct RateLimitedContractSyncCursor<T> {
    indexer: Arc<dyn Indexer<T>>,
    store: Arc<dyn HyperlaneWatermarkedLogStore<T>>,
    tip: u32,
    last_tip_update: Instant,
    eta_calculator: SyncerEtaCalculator,
    sync_state: SyncState,
    metrics: Arc<CursorMetrics>,
    domain: HyperlaneDomain,
    idle_sleep_duration: Duration,
    configured_interval: Option<Duration>,
}

impl<T: Indexable + Sync + Send + Debug + 'static> RateLimitedContractSyncCursor<T> {
    /// Construct a new contract sync helper.
    #[allow(clippy::too_many_arguments)]
    pub async fn new(
        indexer: Arc<dyn Indexer<T>>,
        metrics: Arc<CursorMetrics>,
        domain: &HyperlaneDomain,
        store: Arc<dyn HyperlaneWatermarkedLogStore<T>>,
        chunk_size: u32,
        initial_height: i64,
        watermark: Option<u32>,
        idle_sleep_duration: Duration,
        configured_interval: Option<Duration>,
    ) -> Result<Self> {
        let tip = indexer.get_finalized_block_number().await?;

        // if initial_height is negative, then we want to use a relative
        // height
        let index_start_height = if initial_height < 0 {
            (tip as i64).saturating_add(initial_height)
        } else {
            initial_height
        };

        let index_start_height = watermark
            .map(|w| if w as i64 <= index_start_height {
                tracing::warn!(
                    ?w,
                    ?index_start_height,
                    "Watermark from database is lower than the configured lowest block height, using the configured block height"
                );
                index_start_height
            } else { w as i64 })
            .unwrap_or(index_start_height);

        let index_start_height: u32 = index_start_height as u32;

        Ok(Self {
            indexer,
            store,
            tip,
            last_tip_update: Instant::now(),
            eta_calculator: SyncerEtaCalculator::new(index_start_height, tip, ETA_TIME_WINDOW),
            sync_state: SyncState::new(
                chunk_size,
                index_start_height,
                index_start_height,
                // The rate limited cursor currently only syncs in the forward direction.
                SyncDirection::Forward,
            ),
            metrics,
            domain: domain.to_owned(),
            idle_sleep_duration,
            configured_interval,
        })
    }

    /// Wait based on how close we are to the tip and update the tip,
    /// i.e. the highest block we may scrape.
    async fn get_rate_limit(&self) -> Result<Option<Duration>> {
        if self
            .sync_state
            .next_block
            .saturating_add(self.sync_state.chunk_size)
            < self.tip
        {
            // If doing the full chunk wouldn't exceed the already known tip we do not need to rate limit.
            return Ok(None);
        }

        // We are within one chunk size of the known tip.
        // If it's been less than the refresh window since the last tip update, sleep for a bit
        // until we're ready to fetch the next tip. This used to be a hardcoded 30s regardless of
        // config, which silently overrode an explicitly configured interval for any chain near
        // tip. We only shrink the window when the operator explicitly configured an interval
        // (e.g. fastpath's 1s) - chains that didn't configure one keep the original 30s default,
        // since lowering it for everyone would multiply tip-refresh RPC calls fleet-wide.
        let refresh_window = self.configured_interval.unwrap_or(Duration::from_secs(30));
        if let Some(sleep_time) = refresh_window.checked_sub(self.last_tip_update.elapsed()) {
            return Ok(Some(sleep_time));
        }
        Ok(None)
    }

    fn sync_end(&self) -> u32 {
        self.tip
    }

    fn sync_position(&self) -> u32 {
        self.sync_state.next_block
    }

    fn sync_step(&self) -> u32 {
        self.sync_state.chunk_size
    }

    async fn get_next_range(&self) -> Result<Option<RangeInclusive<u32>>> {
        let tip = self.indexer.get_finalized_block_number().await?;
        self.sync_state.get_next_range(tip).await
    }

    fn sync_eta(&mut self) -> Duration {
        let sync_end = self.sync_end();
        let to = u32::min(
            sync_end,
            self.sync_position().saturating_add(self.sync_step()),
        );
        let from = self.sync_position();
        if to < sync_end {
            self.eta_calculator.calculate(from, sync_end)
        } else {
            Duration::from_secs(0)
        }
    }

    async fn update_metrics(&self) {
        let latest_block = self.latest_queried_block();
        let chain_name = self.domain.name();
        // The rate limited cursor currently only syncs in the forward direction.
        let label_values = &[T::name(), chain_name, "forward_rate_limited"];

        self.metrics
            .cursor_current_block
            .with_label_values(label_values)
            .set(latest_block as i64);
    }
}

#[async_trait]
impl<T> ContractSyncCursor<T> for RateLimitedContractSyncCursor<T>
where
    T: Indexable + Send + Sync + Debug + 'static,
{
    async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
        let eta = self.sync_eta();

        let rate_limit = self.get_rate_limit().await?;
        if let Some(rate_limit) = rate_limit {
            return Ok((CursorAction::Sleep(rate_limit), eta));
        }

        if let Some(range) = self.get_next_range().await? {
            return Ok((CursorAction::Query(range), eta));
        } else {
            return Ok((CursorAction::Sleep(self.idle_sleep_duration), eta));
        }
    }

    fn latest_queried_block(&self) -> u32 {
        self.sync_state.next_block.saturating_sub(1)
    }

    async fn update(
        &mut self,
        _: Vec<(Indexed<T>, LogMeta)>,
        range: RangeInclusive<u32>,
    ) -> Result<()> {
        self.update_metrics().await;
        // Store a relatively conservative view of the high watermark, which should allow a single watermark to be
        // safely shared across multiple cursors, so long as they are running sufficiently in sync
        self.store
            .store_high_watermark(u32::max(
                self.sync_state.start_block,
                self.sync_state
                    .next_block
                    .saturating_sub(self.sync_state.chunk_size),
            ))
            .await?;
        self.sync_state.update_range(range);

        match self.indexer.get_finalized_block_number().await {
            Ok(tip) => {
                // we retrieved a new tip value, go ahead and update.
                self.last_tip_update = Instant::now();
                self.tip = tip;
                Ok(())
            }
            Err(e) => {
                return Err(eyre::eyre!(
                    "Failed to update the cursor because we could not get the current tip: {}",
                    e
                ))
            }
        }
    }
}

impl<T: Indexable> Debug for RateLimitedContractSyncCursor<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RateLimitedContractSyncCursor")
            .field("tip", &self.tip)
            .field("last_tip_update", &self.last_tip_update)
            .field("sync_state", &self.sync_state)
            .field("domain", &self.domain)
            .finish()
    }
}

#[cfg(test)]
pub(crate) mod test {
    use super::*;
    use crate::cursors::CursorType;
    use hyperlane_core::{ChainResult, HyperlaneDomainProtocol, HyperlaneLogStore};
    use mockall::{self, Sequence};

    const CHUNK_SIZE: u32 = 10;
    const INITIAL_HEIGHT: i64 = 0;

    #[derive(Debug, Clone)]
    struct MockIndexable;

    unsafe impl Sync for MockIndexable {}
    unsafe impl Send for MockIndexable {}

    impl Indexable for MockIndexable {
        fn indexing_cursor(_domain: HyperlaneDomainProtocol) -> CursorType {
            CursorType::RateLimited
        }

        fn name() -> &'static str {
            "mock_indexable"
        }
    }

    mockall::mock! {
        pub Indexer<T: Indexable + Send + Sync> {}

        impl<T: Indexable + Send + Sync> Debug for Indexer<T> {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        #[async_trait]
        impl<T: Indexable + Send + Sync> Indexer<T> for Indexer<T> {
            async fn fetch_logs_in_range(&self, range: RangeInclusive<u32>) -> ChainResult<Vec<(hyperlane_core::Indexed<T>, LogMeta)>>;
            async fn get_finalized_block_number(&self) -> ChainResult<u32>;
        }
    }

    mockall::mock! {
        pub Db<T: Indexable + Send + Sync> {}

        impl<T: Indexable + Send + Sync> Debug for Db<T> {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        #[async_trait]
        impl<T: Indexable + Send + Sync> HyperlaneLogStore<T> for Db<T> {
            async fn store_logs(&self, logs: &[(hyperlane_core::Indexed<T>, LogMeta)]) -> Result<u32>;
        }

        #[async_trait]
        impl<T: Indexable + Send + Sync> HyperlaneWatermarkedLogStore<T> for Db<T> {
            async fn retrieve_high_watermark(&self) -> Result<Option<u32>>;
            async fn store_high_watermark(&self, block_number: u32) -> Result<()>;
        }
    }

    fn mock_cursor_metrics() -> CursorMetrics {
        CursorMetrics {
            cursor_current_block: prometheus::IntGaugeVec::new(
                prometheus::Opts::new("cursor_current_block", "Current block of the cursor")
                    .namespace("mock")
                    .subsystem("cursor"),
                &["event_type", "chain", "cursor_type"],
            )
            .unwrap(),
            cursor_current_sequence: prometheus::IntGaugeVec::new(
                prometheus::Opts::new("cursor_current_sequence", "Current sequence of the cursor")
                    .namespace("mock")
                    .subsystem("cursor"),
                &["event_type", "chain", "cursor_type"],
            )
            .unwrap(),
            cursor_max_sequence: prometheus::IntGaugeVec::new(
                prometheus::Opts::new("cursor_max_sequence", "Max sequence of the cursor")
                    .namespace("mock")
                    .subsystem("cursor"),
                &["event_type", "chain"],
            )
            .unwrap(),
        }
    }
    async fn mock_rate_limited_cursor<T: Indexable + Debug + Send + Sync + 'static>(
        custom_chain_tips: Option<Vec<u32>>,
    ) -> RateLimitedContractSyncCursor<T> {
        mock_rate_limited_cursor_with_interval(custom_chain_tips, None).await
    }

    async fn mock_rate_limited_cursor_with_interval<
        T: Indexable + Debug + Send + Sync + 'static,
    >(
        custom_chain_tips: Option<Vec<u32>>,
        configured_interval: Option<Duration>,
    ) -> RateLimitedContractSyncCursor<T> {
        let mut seq = Sequence::new();
        let mut indexer = MockIndexer::<T>::new();
        match custom_chain_tips {
            Some(chain_tips) => {
                for tip in chain_tips {
                    indexer
                        .expect_get_finalized_block_number()
                        .times(1)
                        .in_sequence(&mut seq)
                        .returning(move || Ok(tip));
                }
            }
            None => {
                indexer
                    .expect_get_finalized_block_number()
                    .returning(move || Ok(100));
                indexer
                    .expect_get_finalized_block_number()
                    .returning(move || Ok(100));
            }
        }

        let mut db = MockDb::new();
        let metrics = mock_cursor_metrics();
        db.expect_store_high_watermark().returning(|_| Ok(()));
        let chunk_size = CHUNK_SIZE;
        let initial_height = INITIAL_HEIGHT;
        RateLimitedContractSyncCursor::new(
            Arc::new(indexer),
            Arc::new(metrics),
            &HyperlaneDomain::new_test_domain("test"),
            Arc::new(db),
            chunk_size,
            initial_height,
            None,
            Duration::from_secs(5),
            configured_interval,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn test_next_action_retries_if_update_isnt_called() {
        let mut cursor = mock_rate_limited_cursor::<MockIndexable>(None).await;
        let (action_1, _) = cursor.next_action().await.unwrap();
        let (_action_2, _) = cursor.next_action().await.unwrap();

        // Calling next_action without updating the cursor should return the same action
        assert!(matches!(action_1, _action_2));
    }

    #[tokio::test]
    async fn test_next_action_changes_if_update_is_called() {
        let mut cursor = mock_rate_limited_cursor::<MockIndexable>(None).await;
        let (action_1, _) = cursor.next_action().await.unwrap();

        let range = match action_1 {
            CursorAction::Query(range) => range,
            _ => panic!("Expected Query action"),
        };
        cursor.update(vec![], range.clone()).await.unwrap();

        let (action_3, _) = cursor.next_action().await.unwrap();
        let _expected_range = range.end() + 1..=(range.end() + CHUNK_SIZE);
        assert!(matches!(action_3, CursorAction::Query(_expected_range)));
    }

    #[tokio::test]
    async fn test_next_action_sleeps_if_tip_is_not_updated() {
        let chain_tips = vec![10];
        let mut cursor = mock_rate_limited_cursor::<MockIndexable>(Some(chain_tips)).await;
        let (action, _) = cursor.next_action().await.unwrap();
        assert!(matches!(action, CursorAction::Sleep(_)));
    }

    /// When an interval is explicitly configured (e.g. fastpath's 1s), it must govern the
    /// near-tip throttle too - otherwise the configured interval is silently overridden by a
    /// much longer wait whenever the cursor is within one chunk of tip.
    #[tokio::test]
    async fn test_get_rate_limit_uses_configured_interval_when_set() {
        let chain_tips = vec![10];
        let cursor = mock_rate_limited_cursor_with_interval::<MockIndexable>(
            Some(chain_tips),
            Some(Duration::from_secs(1)),
        )
        .await;

        // next_block (0) + chunk_size (10) == tip (10), so we're within one chunk of tip and
        // get_rate_limit's near-tip branch applies. last_tip_update was just set at construction.
        let sleep_time = cursor
            .get_rate_limit()
            .await
            .expect("get_rate_limit must not fail")
            .expect("must sleep when within one chunk of the known tip");
        assert!(
            sleep_time <= Duration::from_secs(1),
            "sleep_time {sleep_time:?} exceeds the explicitly configured 1s interval - the \
             near-tip throttle is not governed by the configured interval"
        );
    }

    /// Chains that don't explicitly configure `index.interval` must keep the original 30s
    /// near-tip refresh throttle - shrinking it to the 5s idle-sleep default for every
    /// unconfigured chain would multiply tip-refresh RPC calls fleet-wide, not just for the
    /// fastpath context the configurable interval was added for.
    #[tokio::test]
    async fn test_get_rate_limit_preserves_default_window_when_unset() {
        let chain_tips = vec![10];
        let cursor = mock_rate_limited_cursor::<MockIndexable>(Some(chain_tips)).await;

        let sleep_time = cursor
            .get_rate_limit()
            .await
            .expect("get_rate_limit must not fail")
            .expect("must sleep when within one chunk of the known tip");
        assert!(
            sleep_time > Duration::from_secs(5),
            "sleep_time {sleep_time:?} is at or below the 5s idle-sleep default - an unset \
             interval must keep the original 30s near-tip refresh throttle"
        );
    }
}
