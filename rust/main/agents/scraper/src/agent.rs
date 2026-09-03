use std::{
    collections::HashMap,
    panic::AssertUnwindSafe,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use derive_more::AsRef;
use futures::{future::try_join_all, FutureExt};
use hyperlane_core::{
    rpc_clients::RPC_RETRY_SLEEP_DURATION, Delivery, HyperlaneDomain, HyperlaneLogStore,
    HyperlaneMessage, IndexMode, InterchainGasPayment, MerkleTreeInsertion, SameChainCcrSwap, H512,
};
use prometheus::{HistogramVec, IntCounterVec, IntGauge, IntGaugeVec};
use tokio::{
    sync::mpsc::Receiver as MpscReceiver,
    task::JoinHandle,
    time::{interval, sleep, Instant, MissedTickBehavior},
};
use tracing::{info, info_span, instrument, trace, warn, Instrument};

use hyperlane_base::{
    broadcast::BroadcastMpscSender, metrics::AgentMetrics, settings::IndexSettings, AgentMetadata,
    BaseAgent, ChainMetrics, ChainSpecificMetricsUpdater, ContractSyncMetrics, ContractSyncer,
    CoreMetrics, HyperlaneAgentCore, RuntimeMetrics, SyncOptions,
};

use crate::{
    db::ScraperDb,
    settings::ScraperSettings,
    store::{HyperlaneDbStore, RawDispatchReconciliationResult, RawDispatchRetryBackoff},
};

const CURSOR_INSTANTIATION_ATTEMPTS: usize = 10;
const RAW_DISPATCH_RECONCILIATION_BATCH_SIZE: u64 = 100;
// Reconciliation is a fallback for dispatches that fail inline enrichment. Five minutes keeps
// recovery prompt while cutting steady-state anti-join scans by 80% relative to the old minute.
const RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP: Duration = Duration::from_secs(5 * 60);
const RAW_DISPATCH_RECONCILIATION_BACKLOG_SLEEP: Duration = Duration::from_secs(2);
// A full sweep is only a correctness fallback for sequence commit-order races and old rows whose
// body is populated after the incremental watermark passes them. Thirty minutes cuts historical
// anti-joins by 83% while bounding those exceptional discoveries to half an hour.
const RAW_DISPATCH_RECONCILIATION_FULL_SWEEP_INTERVAL: Duration = Duration::from_secs(30 * 60);
const RAW_DISPATCH_RECONCILIATION_RETRY_BATCH_SIZE: usize = 100;
const LIVENESS_UPDATE_INTERVAL: Duration = Duration::from_secs(30);

const RAW_DISPATCH_DISCOVERY_FRONTIER_KIND: &str = "discovery_frontier";
const RAW_DISPATCH_DISCOVERY_PAGE_KIND: &str = "discovery_page";
const RAW_DISPATCH_RETRY_PAGE_KIND: &str = "retry_page";
const RAW_DISPATCH_SWEEP_FRONTIER_KIND: &str = "sweep_frontier";
const RAW_DISPATCH_SWEEP_PAGE_KIND: &str = "sweep_page";

#[derive(Debug, Clone, Copy)]
struct RawDispatchScan {
    after_id: i64,
    through_id: i64,
    next_page_at: Instant,
}

impl RawDispatchScan {
    fn new(after_id: i64, through_id: i64, now: Instant) -> Option<Self> {
        (through_id > after_id).then_some(Self {
            after_id,
            through_id,
            next_page_at: now,
        })
    }

    /// Returns true once the snapshot is exhausted. A full page advances only to the last row
    /// returned; a short page proves that every candidate through the immutable frontier was read.
    fn complete_page(&mut self, result: &RawDispatchReconciliationResult, now: Instant) -> bool {
        if raw_dispatch_reconciliation_scan_complete(result) {
            true
        } else {
            self.after_id = result.next_after_id;
            self.next_page_at = instant_after(now, RAW_DISPATCH_RECONCILIATION_BACKLOG_SLEEP);
            false
        }
    }
}

#[derive(Debug, Clone)]
struct RawDispatchReconciliationMetrics {
    operations: IntCounterVec,
    duration: HistogramVec,
    pending_retries: IntGaugeVec,
    retry_capacity_overflows: IntCounterVec,
}

impl RawDispatchReconciliationMetrics {
    fn new(metrics: &CoreMetrics) -> Self {
        let operations = metrics
            .new_int_counter(
                "raw_message_dispatch_reconciliation_operations",
                "Number of raw dispatch reconciliation operations",
                &["chain", "kind"],
            )
            .expect("failed to register raw dispatch reconciliation operation metric");
        let duration = metrics
            .new_histogram(
                "raw_message_dispatch_reconciliation_duration_seconds",
                "Raw dispatch reconciliation operation duration",
                &["chain", "kind"],
                vec![0.01, 0.1, 0.5, 1.0, 5.0, 15.0, 30.0, 60.0, 120.0],
            )
            .expect("failed to register raw dispatch reconciliation duration metric");
        let pending_retries = metrics
            .new_int_gauge(
                "raw_message_dispatch_reconciliation_pending_retries",
                "Raw dispatch rows waiting for a direct retry",
                &["chain"],
            )
            .expect("failed to register raw dispatch reconciliation retry metric");
        let retry_capacity_overflows = metrics
            .new_int_counter(
                "raw_message_dispatch_reconciliation_retry_capacity_overflows",
                "Number of missing raw dispatches left to the completeness sweep because the direct retry set was full",
                &["chain"],
            )
            .expect("failed to register raw dispatch reconciliation retry overflow metric");
        Self {
            operations,
            duration,
            pending_retries,
            retry_capacity_overflows,
        }
    }

    fn start(&self, chain: &str, kind: &str) -> prometheus::HistogramTimer {
        self.operations.with_label_values(&[chain, kind]).inc();
        self.duration
            .with_label_values(&[chain, kind])
            .start_timer()
    }

    fn set_pending_retries(&self, chain: &str, count: usize) {
        self.pending_retries
            .with_label_values(&[chain])
            .set(count.try_into().unwrap_or(i64::MAX));
    }

    fn add_retry_capacity_overflows(&self, chain: &str, count: usize) {
        self.retry_capacity_overflows
            .with_label_values(&[chain])
            .inc_by(count as u64);
    }
}

fn raw_dispatch_reconciliation_initial_delay(domain_id: u32) -> Duration {
    // Multiplication mixes small, sequential domain IDs before placing each chain in a stable
    // phase of the polling window. This avoids a synchronized DB burst after scraper restarts.
    let offset = u64::from(domain_id)
        .wrapping_mul(2_654_435_761)
        .checked_rem(RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP.as_secs())
        .unwrap_or_default();
    Duration::from_secs(offset)
}

fn instant_after(now: Instant, duration: Duration) -> Instant {
    now.checked_add(duration).unwrap_or(now)
}

fn failed_lane_retry_at(now: Instant) -> Instant {
    // Keep the failed lane asleep for two global cooldowns. When the first cooldown expires,
    // another due lane gets a turn instead of the same failure monopolizing every wake.
    let delay = RPC_RETRY_SLEEP_DURATION
        .checked_mul(2)
        .unwrap_or(Duration::MAX);
    instant_after(now, delay)
}

fn raw_dispatch_reconciliation_scan_complete(result: &RawDispatchReconciliationResult) -> bool {
    result.candidate_count < RAW_DISPATCH_RECONCILIATION_BATCH_SIZE as usize
}

fn raw_dispatch_scan_slot_available(
    discovery_scan: Option<RawDispatchScan>,
    full_sweep: Option<RawDispatchScan>,
) -> bool {
    discovery_scan.is_none() && full_sweep.is_none()
}

#[derive(Debug)]
struct RawDispatchReconciliationSchedule {
    discovery_watermark: i64,
    discovery_scan: Option<RawDispatchScan>,
    full_sweep: Option<RawDispatchScan>,
    next_discovery_at: Instant,
    next_full_sweep_at: Instant,
    retry_not_before: Instant,
    global_not_before: Instant,
}

impl RawDispatchReconciliationSchedule {
    fn new(discovery_watermark: i64, now: Instant, global_not_before: Instant) -> Self {
        Self {
            discovery_watermark,
            discovery_scan: None,
            full_sweep: None,
            next_discovery_at: instant_after(now, RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP),
            next_full_sweep_at: now,
            retry_not_before: now,
            global_not_before,
        }
    }

    fn scan_slot_available(&self) -> bool {
        raw_dispatch_scan_slot_available(self.discovery_scan, self.full_sweep)
    }

    fn scans_are_serialized(&self) -> bool {
        self.discovery_scan.is_none() || self.full_sweep.is_none()
    }

    fn discovery_delay(&self, now: Instant) -> Duration {
        match (self.discovery_scan, self.full_sweep) {
            (Some(scan), _) => scan.next_page_at.saturating_duration_since(now),
            (None, Some(_)) => Duration::MAX,
            (None, None) => self.next_discovery_at.saturating_duration_since(now),
        }
    }

    fn full_sweep_delay(&self, now: Instant) -> Duration {
        match (self.full_sweep, self.discovery_scan) {
            (Some(scan), _) => scan.next_page_at.saturating_duration_since(now),
            (None, Some(_)) => Duration::MAX,
            (None, None) => self.next_full_sweep_at.saturating_duration_since(now),
        }
    }

    fn start_discovery(&mut self, frontier: i64, now: Instant) {
        debug_assert!(self.scan_slot_available());
        self.discovery_scan = RawDispatchScan::new(self.discovery_watermark, frontier, now);
        if self.discovery_scan.is_none() {
            self.next_discovery_at = instant_after(now, RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP);
        }
    }

    fn start_full_sweep(&mut self, frontier: i64, now: Instant) {
        debug_assert!(self.scan_slot_available());
        self.full_sweep = RawDispatchScan::new(0, frontier, now);
        if self.full_sweep.is_none() {
            self.next_full_sweep_at =
                instant_after(now, RAW_DISPATCH_RECONCILIATION_FULL_SWEEP_INTERVAL);
        }
    }

    fn complete_discovery_page(
        &mut self,
        mut scan: RawDispatchScan,
        result: &RawDispatchReconciliationResult,
        now: Instant,
    ) {
        if scan.complete_page(result, now) {
            self.discovery_watermark = self.discovery_watermark.max(scan.through_id);
            self.discovery_scan = None;
            self.next_discovery_at = instant_after(now, RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP);
        } else {
            self.discovery_scan = Some(scan);
        }
    }

    fn complete_full_sweep_page(
        &mut self,
        mut scan: RawDispatchScan,
        result: &RawDispatchReconciliationResult,
        now: Instant,
    ) {
        if scan.complete_page(result, now) {
            self.discovery_watermark = self.discovery_watermark.max(scan.through_id);
            self.full_sweep = None;
            self.next_full_sweep_at =
                instant_after(now, RAW_DISPATCH_RECONCILIATION_FULL_SWEEP_INTERVAL);
        } else {
            self.full_sweep = Some(scan);
        }
    }

    fn defer_retry_lane(&mut self, now: Instant) {
        self.global_not_before = instant_after(now, RPC_RETRY_SLEEP_DURATION);
        self.retry_not_before = failed_lane_retry_at(now);
    }

    fn defer_discovery_frontier(&mut self, now: Instant) {
        self.global_not_before = instant_after(now, RPC_RETRY_SLEEP_DURATION);
        self.next_discovery_at = failed_lane_retry_at(now);
    }

    fn defer_discovery_page(&mut self, scan: RawDispatchScan, now: Instant) {
        self.global_not_before = instant_after(now, RPC_RETRY_SLEEP_DURATION);
        self.discovery_scan = Some(RawDispatchScan {
            next_page_at: failed_lane_retry_at(now),
            ..scan
        });
    }

    fn defer_sweep_frontier(&mut self, now: Instant) {
        self.global_not_before = instant_after(now, RPC_RETRY_SLEEP_DURATION);
        self.next_full_sweep_at = failed_lane_retry_at(now);
    }

    fn defer_sweep_page(&mut self, scan: RawDispatchScan, now: Instant) {
        self.global_not_before = instant_after(now, RPC_RETRY_SLEEP_DURATION);
        self.full_sweep = Some(RawDispatchScan {
            next_page_at: failed_lane_retry_at(now),
            ..scan
        });
    }
}

fn update_liveness_metric(liveness_metric: &IntGauge) {
    let seconds_since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    liveness_metric.set(seconds_since_epoch.try_into().unwrap_or(i64::MAX));
}

async fn sleep_with_liveness(duration: Duration, liveness_metric: &IntGauge) {
    if duration <= LIVENESS_UPDATE_INTERVAL {
        sleep(duration).await;
        return;
    }

    let sleep = sleep(duration);
    tokio::pin!(sleep);

    let mut liveness_interval = interval(LIVENESS_UPDATE_INTERVAL);
    liveness_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    liveness_interval.tick().await;

    loop {
        tokio::select! {
            _ = &mut sleep => break,
            _ = liveness_interval.tick() => update_liveness_metric(liveness_metric),
        }
    }
}

/// A message explorer scraper agent
#[derive(Debug, AsRef)]
#[allow(unused)]
pub struct Scraper {
    #[as_ref]
    core: HyperlaneAgentCore,
    contract_sync_metrics: Arc<ContractSyncMetrics>,
    scrapers: HashMap<u32, ChainScraper>,
    settings: ScraperSettings,
    core_metrics: Arc<CoreMetrics>,
    agent_metrics: AgentMetrics,
    chain_metrics: ChainMetrics,
    runtime_metrics: RuntimeMetrics,
    raw_dispatch_unenriched_max_age: IntGaugeVec,
    raw_dispatch_reconciliation_metrics: RawDispatchReconciliationMetrics,
}

#[derive(Debug)]
struct ChainScraper {
    index_settings: IndexSettings,
    store: HyperlaneDbStore,
    domain: HyperlaneDomain,
}

#[async_trait]
impl BaseAgent for Scraper {
    const AGENT_NAME: &'static str = "scraper";
    type Settings = ScraperSettings;
    type Metadata = AgentMetadata;

    async fn from_settings(
        _agent_metadata: Self::Metadata,
        settings: Self::Settings,
        metrics: Arc<CoreMetrics>,
        agent_metrics: AgentMetrics,
        chain_metrics: ChainMetrics,
        runtime_metrics: RuntimeMetrics,
        _tokio_console_server: console_subscriber::Server,
    ) -> eyre::Result<Self>
    where
        Self: Sized,
    {
        let db = ScraperDb::connect(&settings.db).await?;
        let core = settings.build_hyperlane_core(metrics.clone());

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));
        let raw_dispatch_unenriched_max_age = metrics
            .new_int_gauge(
                "raw_message_dispatch_unenriched_max_age_seconds",
                "Maximum age in seconds of raw message dispatches pending reconciliation",
                &["chain"],
            )
            .expect("failed to register raw dispatch reconciliation age metric");
        let raw_dispatch_reconciliation_metrics = RawDispatchReconciliationMetrics::new(&metrics);

        let scrapers = Self::build_chain_scrapers(
            &settings,
            metrics.clone(),
            &chain_metrics,
            db.clone(),
            contract_sync_metrics.clone(),
        )
        .await;

        trace!(domain_count = scrapers.len(), "Created scrapers");

        Ok(Self {
            core,
            contract_sync_metrics,
            scrapers,
            settings,
            core_metrics: metrics,
            agent_metrics,
            chain_metrics,
            runtime_metrics,
            raw_dispatch_unenriched_max_age,
            raw_dispatch_reconciliation_metrics,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(self) {
        let mut tasks = Vec::with_capacity(self.scrapers.len());

        // running http server
        let server = self
            .core
            .settings
            .server(self.core_metrics.clone())
            .expect("Failed to create server");
        let server_task = tokio::spawn(
            async move {
                server.run();
            }
            .instrument(info_span!("Scraper server")),
        );
        tasks.push(server_task);

        for scraper in self.scrapers.values() {
            let chain_conf = match self.settings.chain_setup(&scraper.domain) {
                Ok(s) => s,
                Err(err) => {
                    tracing::error!(?err, ?scraper.domain, "Failed to get chain config");
                    self.chain_metrics
                        .set_critical_error(scraper.domain.name(), true);
                    continue;
                }
            };

            let metrics_updater = match ChainSpecificMetricsUpdater::new(
                chain_conf,
                self.core_metrics.clone(),
                self.agent_metrics.clone(),
                self.chain_metrics.clone(),
                Self::AGENT_NAME.to_string(),
            )
            .await
            {
                Ok(metrics_updater) => metrics_updater,
                Err(err) => {
                    tracing::error!(?err, ?scraper.domain, "Failed to build metrics updater");
                    self.chain_metrics
                        .set_critical_error(scraper.domain.name(), true);
                    continue;
                }
            };

            let scraper_task = match self
                .try_n_times_to_scrape(scraper, CURSOR_INSTANTIATION_ATTEMPTS)
                .await
            {
                Ok(s) => s,
                Err(err) => {
                    tracing::error!(?err, ?scraper.domain, "Failed to scrape chain");
                    continue;
                }
            };
            tasks.push(scraper_task);
            tasks.push(metrics_updater.spawn());
        }
        tasks.push(self.runtime_metrics.spawn());
        if let Err(err) = try_join_all(tasks).await {
            tracing::error!(error = ?err, "Scraper task panicked");
        }
    }
}

impl Scraper {
    /// Try to scrape attempts times before giving up.
    async fn try_n_times_to_scrape(
        &self,
        scraper: &ChainScraper,
        attempts: usize,
    ) -> eyre::Result<JoinHandle<()>> {
        for i in 0..attempts {
            let scraper_task = match self.scrape(scraper).await {
                Ok(s) => s,
                Err(err) => {
                    tracing::error!(?err, ?scraper.domain, attempt_count=i, "Failed to scrape chain");
                    sleep(RPC_RETRY_SLEEP_DURATION).await;
                    continue;
                }
            };

            self.chain_metrics
                .set_critical_error(scraper.domain.name(), false);
            return Ok(scraper_task);
        }
        self.chain_metrics
            .set_critical_error(scraper.domain.name(), true);
        Err(eyre::eyre!("Failed to scrape chain"))
    }

    /// Sync contract data and other blockchain with the current chain state.
    /// This will spawn long-running contract sync tasks
    #[instrument(fields(domain=%scraper.domain.name()), skip_all)]
    async fn scrape(&self, scraper: &ChainScraper) -> eyre::Result<JoinHandle<()>> {
        let store = scraper.store.clone();
        let index_settings = scraper.index_settings.clone();
        let domain = scraper.domain.clone();

        let mut tasks = Vec::with_capacity(2);
        let (message_indexer, maybe_broadcaster) = self
            .build_message_indexer(
                domain.clone(),
                self.core_metrics.clone(),
                self.contract_sync_metrics.clone(),
                store.clone(),
                index_settings.clone(),
            )
            .await?;
        tasks.push(message_indexer);

        let delivery_indexer = self
            .build_delivery_indexer(
                domain.clone(),
                self.core_metrics.clone(),
                self.contract_sync_metrics.clone(),
                store.clone(),
                index_settings.clone(),
            )
            .await?;
        tasks.push(delivery_indexer);

        let gas_payment_indexer = self
            .build_interchain_gas_payment_indexer(
                domain.clone(),
                self.core_metrics.clone(),
                self.contract_sync_metrics.clone(),
                store.clone(),
                index_settings.clone(),
                BroadcastMpscSender::<H512>::map_get_receiver(maybe_broadcaster.as_ref()).await,
            )
            .await?;
        tasks.push(gas_payment_indexer);

        tasks.push(
            self.build_merkle_tree_insertion_indexer(
                domain.clone(),
                self.core_metrics.clone(),
                self.contract_sync_metrics.clone(),
                store.clone(),
                index_settings.clone(),
            )
            .await?,
        );

        tasks.push(self.build_raw_dispatch_reconciler(
            domain.clone(),
            self.contract_sync_metrics.clone(),
            self.raw_dispatch_unenriched_max_age.clone(),
            self.raw_dispatch_reconciliation_metrics.clone(),
            store.clone(),
        ));

        if let Some(ccr_task) = self
            .build_ccr_indexer(
                domain,
                self.core_metrics.clone(),
                store,
                index_settings.clone(),
            )
            .await?
        {
            tasks.push(ccr_task);
        }

        Ok(tokio::spawn(
            async move {
                try_join_all(tasks)
                    .await
                    .expect("Some scraper tasks failed");
            }
            .instrument(info_span!("Scraper Tasks")),
        ))
    }

    #[instrument(fields(domain=%domain.name()), skip_all)]
    async fn build_chain_scraper(
        domain: &HyperlaneDomain,
        settings: &ScraperSettings,
        metrics: Arc<CoreMetrics>,
        scraper_db: ScraperDb,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
    ) -> eyre::Result<ChainScraper> {
        info!(domain = domain.name(), "create chain scraper for domain");
        let chain_setup = settings.chain_setup(domain)?;
        info!(domain = domain.name(), "create HyperlaneProvider");
        let provider = chain_setup.build_provider(&metrics).await?.into();
        info!(domain = domain.name(), "create HyperlaneDbStore");
        let store = HyperlaneDbStore::new(
            scraper_db,
            domain.clone(),
            chain_setup.addresses.clone(),
            provider,
            &chain_setup.index.clone(),
            Some(contract_sync_metrics.stored_events.clone()),
        )
        .await?;
        Ok(ChainScraper {
            domain: domain.clone(),
            store,
            index_settings: chain_setup.index.clone(),
        })
    }

    async fn build_chain_scrapers(
        settings: &ScraperSettings,
        metrics: Arc<CoreMetrics>,
        chain_metrics: &ChainMetrics,
        scraper_db: ScraperDb,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
    ) -> HashMap<u32, ChainScraper> {
        let mut scrapers: HashMap<u32, ChainScraper> = HashMap::new();

        for domain in settings.chains_to_scrape.iter() {
            match Self::build_chain_scraper(
                domain,
                settings,
                metrics.clone(),
                scraper_db.clone(),
                contract_sync_metrics.clone(),
            )
            .await
            {
                Ok(scraper) => {
                    info!(domain = domain.name(), "insert chain scraper");
                    scrapers.insert(domain.id(), scraper);
                }
                Err(err) => {
                    chain_metrics.set_critical_error(domain.name(), true);
                    info!(
                        domain = domain.name(),
                        ?err,
                        "Failed to build chain scraper"
                    );
                }
            }
        }
        scrapers
    }

    async fn build_message_indexer(
        &self,
        domain: HyperlaneDomain,
        metrics: Arc<CoreMetrics>,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        store: HyperlaneDbStore,
        index_settings: IndexSettings,
    ) -> eyre::Result<(JoinHandle<()>, Option<BroadcastMpscSender<H512>>)> {
        let label = "message_dispatch";
        let sync = self
            .as_ref()
            .settings
            .sequenced_contract_sync::<HyperlaneMessage, _>(
                &domain,
                &metrics.clone(),
                &contract_sync_metrics.clone(),
                store.into(),
                true,
                true,
            )
            .await
            .map_err(|err| {
                tracing::error!(
                    ?err,
                    domain = domain.name(),
                    label,
                    "Error syncing sequenced contract"
                );
                err
            })?;
        let cursor = sync.cursor(index_settings.clone()).await.map_err(|err| {
            tracing::error!(?err, domain = domain.name(), label, "Error getting cursor");
            err
        })?;
        let maybe_broadcaser = sync.get_broadcaster();
        let task = tokio::spawn(
            async move { sync.sync(label, cursor.into()).await }
                .instrument(info_span!("ChainContractSync", chain=%domain.name(), event=label)),
        );
        Ok((task, maybe_broadcaser))
    }

    fn build_raw_dispatch_reconciler(
        &self,
        domain: HyperlaneDomain,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        raw_dispatch_unenriched_max_age: IntGaugeVec,
        reconciliation_metrics: RawDispatchReconciliationMetrics,
        store: HyperlaneDbStore,
    ) -> JoinHandle<()> {
        let domain_name = domain.name().to_owned();
        let span_domain_name = domain_name.clone();
        tokio::spawn(
            async move {
                let stored_events_metric = contract_sync_metrics
                    .stored_events
                    .with_label_values(&["message_dispatch_reconciled", &domain_name]);
                let liveness_metric = contract_sync_metrics.liveness_metrics.with_label_values(&[
                    "raw_message_dispatch_reconciliation",
                    &domain_name,
                    "reconcile_task",
                ]);
                let max_age_metric =
                    raw_dispatch_unenriched_max_age.with_label_values(&[&domain_name]);
                let mut retry_backoff = RawDispatchRetryBackoff::default();

                update_liveness_metric(&liveness_metric);
                sleep_with_liveness(
                    raw_dispatch_reconciliation_initial_delay(domain.id()),
                    &liveness_metric,
                )
                .await;

                let initial_frontier =
                    AssertUnwindSafe(store.latest_reconcilable_raw_dispatch_id())
                        .catch_unwind()
                        .await;
                let (discovery_watermark, global_not_before) = match initial_frontier {
                    Ok(Ok(frontier)) => (frontier, Instant::now()),
                    Ok(Err(err)) => {
                        warn!(
                            ?err,
                            domain = domain_name,
                            "Failed to initialize raw dispatch discovery watermark"
                        );
                        let now = Instant::now();
                        (0, instant_after(now, RPC_RETRY_SLEEP_DURATION))
                    }
                    Err(_) => {
                        warn!(
                            domain = domain_name,
                            "Raw dispatch discovery watermark initialization panicked; retrying"
                        );
                        let now = Instant::now();
                        (0, instant_after(now, RPC_RETRY_SLEEP_DURATION))
                    }
                };
                let now = Instant::now();
                let mut schedule = RawDispatchReconciliationSchedule::new(
                    discovery_watermark,
                    now,
                    global_not_before,
                );

                loop {
                    update_liveness_metric(&liveness_metric);
                    let now = Instant::now();
                    if schedule.global_not_before > now {
                        sleep_with_liveness(
                            schedule.global_not_before.saturating_duration_since(now),
                            &liveness_metric,
                        )
                        .await;
                        continue;
                    }
                    let mut cycle_failed = false;

                    let due_raw_ids = retry_backoff.due_raw_ids(
                        time::OffsetDateTime::now_utc(),
                        RAW_DISPATCH_RECONCILIATION_RETRY_BATCH_SIZE,
                    );
                    if schedule.retry_not_before <= now && !due_raw_ids.is_empty() {
                        let timer = reconciliation_metrics
                            .start(&domain_name, RAW_DISPATCH_RETRY_PAGE_KIND);
                        let result = AssertUnwindSafe(
                            store.retry_raw_message_dispatches(&due_raw_ids, &mut retry_backoff),
                        )
                        .catch_unwind()
                        .await;
                        timer.observe_duration();
                        match result {
                            Ok(Ok(result)) => {
                                stored_events_metric.inc_by(result.stored_count.into());
                                info!(
                                    kind = RAW_DISPATCH_RETRY_PAGE_KIND,
                                    requested = due_raw_ids.len(),
                                    candidates = result.candidate_count,
                                    attempted = result.attempted_count,
                                    stored = result.stored_count,
                                    domain = domain_name,
                                    "Reconciled raw message dispatches"
                                );
                            }
                            Ok(Err(err)) => {
                                warn!(
                                    ?err,
                                    kind = RAW_DISPATCH_RETRY_PAGE_KIND,
                                    domain = domain_name,
                                    "Failed to reconcile raw message dispatches"
                                );
                                schedule.defer_retry_lane(Instant::now());
                                cycle_failed = true;
                            }
                            Err(_) => {
                                warn!(
                                    kind = RAW_DISPATCH_RETRY_PAGE_KIND,
                                    domain = domain_name,
                                    "Raw message dispatch reconciliation panicked; retrying"
                                );
                                schedule.defer_retry_lane(Instant::now());
                                cycle_failed = true;
                            }
                        }
                    }

                    let now = Instant::now();
                    if !cycle_failed
                        && schedule.scan_slot_available()
                        && schedule.next_discovery_at <= now
                    {
                        let timer = reconciliation_metrics
                            .start(&domain_name, RAW_DISPATCH_DISCOVERY_FRONTIER_KIND);
                        let frontier =
                            AssertUnwindSafe(store.latest_reconcilable_raw_dispatch_id())
                                .catch_unwind()
                                .await;
                        timer.observe_duration();
                        match frontier {
                            Ok(Ok(frontier)) => schedule.start_discovery(frontier, now),
                            Ok(Err(err)) => {
                                warn!(
                                    ?err,
                                    kind = RAW_DISPATCH_DISCOVERY_FRONTIER_KIND,
                                    domain = domain_name,
                                    "Failed to snapshot raw dispatch reconciliation frontier"
                                );
                                schedule.defer_discovery_frontier(Instant::now());
                                cycle_failed = true;
                            }
                            Err(_) => {
                                warn!(
                                    kind = RAW_DISPATCH_DISCOVERY_FRONTIER_KIND,
                                    domain = domain_name,
                                    "Raw dispatch reconciliation frontier query panicked; retrying"
                                );
                                schedule.defer_discovery_frontier(Instant::now());
                                cycle_failed = true;
                            }
                        }
                    }

                    if let Some(scan) = schedule
                        .discovery_scan
                        .filter(|scan| !cycle_failed && scan.next_page_at <= now)
                    {
                        let timer = reconciliation_metrics
                            .start(&domain_name, RAW_DISPATCH_DISCOVERY_PAGE_KIND);
                        let result = AssertUnwindSafe(store.reconcile_raw_message_dispatches(
                            scan.after_id,
                            scan.through_id,
                            RAW_DISPATCH_RECONCILIATION_BATCH_SIZE,
                            &mut retry_backoff,
                        ))
                        .catch_unwind()
                        .await;
                        timer.observe_duration();
                        match result {
                            Ok(Ok(result)) => {
                                stored_events_metric.inc_by(result.stored_count.into());
                                info!(
                                    kind = RAW_DISPATCH_DISCOVERY_PAGE_KIND,
                                    candidates = result.candidate_count,
                                    attempted = result.attempted_count,
                                    skipped_backoff = result.skipped_backoff_count,
                                    stored = result.stored_count,
                                    retry_capacity_overflows = result.untracked_count,
                                    after_id = scan.after_id,
                                    through_id = scan.through_id,
                                    domain = domain_name,
                                    "Reconciled raw message dispatches"
                                );
                                reconciliation_metrics.add_retry_capacity_overflows(
                                    &domain_name,
                                    result.untracked_count,
                                );
                                schedule.complete_discovery_page(scan, &result, Instant::now());
                            }
                            Ok(Err(err)) => {
                                warn!(
                                    ?err,
                                    kind = RAW_DISPATCH_DISCOVERY_PAGE_KIND,
                                    domain = domain_name,
                                    "Failed to reconcile raw message dispatches"
                                );
                                schedule.defer_discovery_page(scan, Instant::now());
                                cycle_failed = true;
                            }
                            Err(_) => {
                                warn!(
                                    kind = RAW_DISPATCH_DISCOVERY_PAGE_KIND,
                                    domain = domain_name,
                                    "Raw message dispatch reconciliation panicked; retrying"
                                );
                                schedule.defer_discovery_page(scan, Instant::now());
                                cycle_failed = true;
                            }
                        }
                    }

                    let now = Instant::now();
                    if !cycle_failed
                        && schedule.scan_slot_available()
                        && schedule.next_full_sweep_at <= now
                    {
                        let timer = reconciliation_metrics
                            .start(&domain_name, RAW_DISPATCH_SWEEP_FRONTIER_KIND);
                        let frontier =
                            AssertUnwindSafe(store.latest_reconcilable_raw_dispatch_id())
                                .catch_unwind()
                                .await;
                        timer.observe_duration();
                        match frontier {
                            Ok(Ok(frontier)) => schedule.start_full_sweep(frontier, now),
                            Ok(Err(err)) => {
                                warn!(
                                    ?err,
                                    kind = RAW_DISPATCH_SWEEP_FRONTIER_KIND,
                                    domain = domain_name,
                                    "Failed to snapshot raw dispatch reconciliation frontier"
                                );
                                schedule.defer_sweep_frontier(Instant::now());
                                cycle_failed = true;
                            }
                            Err(_) => {
                                warn!(
                                    kind = RAW_DISPATCH_SWEEP_FRONTIER_KIND,
                                    domain = domain_name,
                                    "Raw dispatch reconciliation frontier query panicked; retrying"
                                );
                                schedule.defer_sweep_frontier(Instant::now());
                                cycle_failed = true;
                            }
                        }
                    }

                    if let Some(scan) = schedule
                        .full_sweep
                        .filter(|scan| !cycle_failed && scan.next_page_at <= now)
                    {
                        let timer = reconciliation_metrics
                            .start(&domain_name, RAW_DISPATCH_SWEEP_PAGE_KIND);
                        let result = AssertUnwindSafe(store.reconcile_raw_message_dispatches(
                            scan.after_id,
                            scan.through_id,
                            RAW_DISPATCH_RECONCILIATION_BATCH_SIZE,
                            &mut retry_backoff,
                        ))
                        .catch_unwind()
                        .await;
                        timer.observe_duration();
                        match result {
                            Ok(Ok(result)) => {
                                stored_events_metric.inc_by(result.stored_count.into());
                                info!(
                                    kind = RAW_DISPATCH_SWEEP_PAGE_KIND,
                                    candidates = result.candidate_count,
                                    attempted = result.attempted_count,
                                    skipped_backoff = result.skipped_backoff_count,
                                    stored = result.stored_count,
                                    retry_capacity_overflows = result.untracked_count,
                                    after_id = scan.after_id,
                                    through_id = scan.through_id,
                                    domain = domain_name,
                                    "Reconciled raw message dispatches"
                                );
                                reconciliation_metrics.add_retry_capacity_overflows(
                                    &domain_name,
                                    result.untracked_count,
                                );
                                schedule.complete_full_sweep_page(scan, &result, Instant::now());
                            }
                            Ok(Err(err)) => {
                                warn!(
                                    ?err,
                                    kind = RAW_DISPATCH_SWEEP_PAGE_KIND,
                                    domain = domain_name,
                                    "Failed to reconcile raw message dispatches"
                                );
                                schedule.defer_sweep_page(scan, Instant::now());
                            }
                            Err(_) => {
                                warn!(
                                    kind = RAW_DISPATCH_SWEEP_PAGE_KIND,
                                    domain = domain_name,
                                    "Raw message dispatch reconciliation panicked; retrying"
                                );
                                schedule.defer_sweep_page(scan, Instant::now());
                            }
                        }
                    }

                    reconciliation_metrics.set_pending_retries(&domain_name, retry_backoff.len());
                    debug_assert!(schedule.scans_are_serialized());
                    max_age_metric.set(
                        retry_backoff
                            .max_unenriched_age_seconds(time::OffsetDateTime::now_utc())
                            .try_into()
                            .unwrap_or(i64::MAX),
                    );

                    let now = Instant::now();
                    let retry_delay = retry_backoff
                        .next_retry_delay(time::OffsetDateTime::now_utc())
                        .unwrap_or(Duration::MAX);
                    let retry_delay = if schedule.retry_not_before > now {
                        retry_delay.max(schedule.retry_not_before.saturating_duration_since(now))
                    } else {
                        retry_delay
                    };
                    let discovery_delay = schedule.discovery_delay(now);
                    let sweep_delay = schedule.full_sweep_delay(now);
                    sleep_with_liveness(
                        retry_delay.min(discovery_delay).min(sweep_delay),
                        &liveness_metric,
                    )
                    .await;
                }
            }
            .instrument(info_span!("RawDispatchReconciliation", chain=%span_domain_name)),
        )
    }

    async fn build_delivery_indexer(
        &self,
        domain: HyperlaneDomain,
        metrics: Arc<CoreMetrics>,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        store: HyperlaneDbStore,
        index_settings: IndexSettings,
    ) -> eyre::Result<JoinHandle<()>> {
        let label = "message_delivery";
        let sync = self
            .as_ref()
            .settings
            .contract_sync::<Delivery, _>(
                &domain,
                &metrics.clone(),
                &contract_sync_metrics.clone(),
                Arc::new(store.clone()) as _,
                true,
                true,
            )
            .await
            .map_err(|err| {
                tracing::error!(
                    ?err,
                    domain = domain.name(),
                    label,
                    "Error syncing contract"
                );
                err
            })?;
        let cursor = sync.cursor(index_settings.clone()).await.map_err(|err| {
            tracing::error!(?err, domain = domain.name(), label, "Error getting cursor");
            err
        })?;
        // there is no txid receiver for delivery indexing, since delivery txs aren't batched with
        // other types of indexed txs / events
        Ok(tokio::spawn(
            async move { sync.sync(label, SyncOptions::new(Some(cursor), None)).await }
                .instrument(info_span!("ChainContractSync", chain=%domain.name(), event=label)),
        ))
    }

    async fn build_interchain_gas_payment_indexer(
        &self,
        domain: HyperlaneDomain,
        metrics: Arc<CoreMetrics>,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        store: HyperlaneDbStore,
        index_settings: IndexSettings,
        tx_id_receiver: Option<MpscReceiver<H512>>,
    ) -> eyre::Result<JoinHandle<()>> {
        let label = "gas_payment";
        let sync = self
            .as_ref()
            .settings
            .contract_sync::<InterchainGasPayment, _>(
                &domain,
                &metrics.clone(),
                &contract_sync_metrics.clone(),
                Arc::new(store.clone()) as _,
                true,
                true,
            )
            .await
            .map_err(|err| {
                tracing::error!(
                    ?err,
                    domain = domain.name(),
                    label,
                    "Error syncing contract"
                );
                err
            })?;
        let cursor = sync.cursor(index_settings.clone()).await.map_err(|err| {
            tracing::error!(?err, domain = domain.name(), label, "Error getting cursor");
            err
        })?;
        Ok(tokio::spawn(
            async move {
                sync.sync(label, SyncOptions::new(Some(cursor), tx_id_receiver))
                    .await
            }
            .instrument(info_span!("ChainContractSync", chain=%domain.name(), event=label)),
        ))
    }

    async fn build_merkle_tree_insertion_indexer(
        &self,
        domain: HyperlaneDomain,
        metrics: Arc<CoreMetrics>,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        store: HyperlaneDbStore,
        index_settings: IndexSettings,
    ) -> eyre::Result<JoinHandle<()>> {
        let label = "merkle_tree_insertion";
        let sync = self
            .settings
            .sequenced_contract_sync::<MerkleTreeInsertion, _>(
                &domain,
                &metrics,
                &contract_sync_metrics,
                store.into(),
                false,
                false,
            )
            .await?;
        let mut index_settings = index_settings;
        if matches!(index_settings.mode, IndexMode::Sequence) {
            index_settings.from = 0;
        }
        let cursor = sync.cursor(index_settings).await?;
        Ok(tokio::spawn(
            async move { sync.sync(label, cursor.into()).await }
                .instrument(info_span!("ChainContractSync", chain=%domain.name(), event=label)),
        ))
    }

    /// Build a CCR swap indexer for the given domain if it has CCR routers configured.
    /// Returns `None` if the domain has no CCR config.
    async fn build_ccr_indexer(
        &self,
        domain: HyperlaneDomain,
        metrics: Arc<CoreMetrics>,
        store: HyperlaneDbStore,
        index_settings: IndexSettings,
    ) -> eyre::Result<Option<JoinHandle<()>>> {
        let ccr_router_map = match self.settings.ccr_routers.get(&domain.id()) {
            Some(m) if !m.is_empty() => m,
            _ => return Ok(None),
        };

        let ccr_to_erc20 = ccr_router_map.clone();
        let local_domain = domain.id();

        let chain_setup = self.as_ref().settings.chain_setup(&domain)?;
        let Some(indexer) = chain_setup
            .build_ccr_swap_indexer(&metrics, local_domain, ccr_to_erc20)
            .await?
        else {
            return Ok(None);
        };

        let chunk_size = index_settings.chunk_size;
        if chunk_size == 0 {
            warn!(?domain, "index.chunk must be > 0 for CCR sync; skipping");
            return Ok(None);
        }
        let default_from = index_settings.from.max(0) as u32;

        // Create a dedicated BlockCursor for CCR swaps keyed by (domain, "ccr_swap").
        // This is independent of the message/delivery/gas cursor so the two indexers
        // don't race to read and overwrite each other's watermark.
        let ccr_cursor = Arc::new(
            store
                .db
                .block_cursor(local_domain, "ccr_swap", default_from.into())
                .await?,
        );

        Ok(Some(tokio::spawn(
            async move {
                let mut from_block = ccr_cursor.height().await as u32;

                loop {
                    let tip = match indexer.get_finalized_block_number().await {
                        Ok(tip) => tip,
                        Err(err) => {
                            warn!(?err, "Failed to get finalized block number for CCR indexer");
                            sleep(RPC_RETRY_SLEEP_DURATION).await;
                            continue;
                        }
                    };

                    if from_block > tip {
                        sleep(Duration::from_secs(5)).await;
                        continue;
                    }

                    let to_block = tip.min(from_block.saturating_add(chunk_size).saturating_sub(1));

                    let logs = match indexer.fetch_logs_in_range(from_block..=to_block).await {
                        Ok(logs) => logs,
                        Err(err) => {
                            warn!(?err, from_block, to_block, "Failed to fetch CCR swap logs");
                            sleep(RPC_RETRY_SLEEP_DURATION).await;
                            continue;
                        }
                    };

                    if !logs.is_empty() {
                        if let Err(err) =
                            HyperlaneLogStore::<SameChainCcrSwap>::store_logs(&store, &logs).await
                        {
                            warn!(
                                ?err,
                                from_block, to_block, "Failed to store CCR swaps; retrying range"
                            );
                            sleep(RPC_RETRY_SLEEP_DURATION).await;
                            continue;
                        }
                    }

                    ccr_cursor.update(to_block.into()).await;
                    if let Err(e) = ccr_cursor.flush().await {
                        warn!(?e, from_block, to_block, "Failed to flush CCR cursor; advancing anyway, next flush will catch up");
                    }
                    from_block = to_block.saturating_add(1);
                }
            }
            .instrument(info_span!("CcrSwapSync", chain=%domain.name())),
        )))
    }
}

#[cfg(test)]
mod test {
    use std::{
        collections::BTreeMap,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use ethers::utils::hex;
    use ethers_prometheus::middleware::PrometheusMiddlewareConf;
    use prometheus::Registry;
    use reqwest::Url;
    use sea_orm::{DatabaseBackend, MockDatabase};

    use hyperlane_base::{
        settings::{
            ChainConf, ChainConnectionConf, CoreContractAddresses, Settings, TracingConfig,
        },
        ChainMetrics,
    };
    use hyperlane_core::{
        config::OpSubmissionConfig, IndexMode, KnownHyperlaneDomain, ReorgPeriod, H256,
    };
    use hyperlane_ethereum as h_eth;

    use super::*;

    async fn run_pending_tasks() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn reconciliation_idle_sleep_updates_liveness() {
        let liveness = IntGauge::new("test_reconcile_liveness", "test reconcile liveness")
            .expect("test gauge should be valid");
        let liveness_clone = liveness.clone();
        let task = tokio::spawn(async move {
            sleep_with_liveness(Duration::from_secs(65), &liveness_clone).await;
        });

        run_pending_tasks().await;
        tokio::time::advance(LIVENESS_UPDATE_INTERVAL - Duration::from_secs(1)).await;
        run_pending_tasks().await;
        assert_eq!(liveness.get(), 0);

        tokio::time::advance(Duration::from_secs(1)).await;
        run_pending_tasks().await;
        assert!(liveness.get() > 0);
        assert!(!task.is_finished());

        liveness.set(0);
        tokio::time::advance(LIVENESS_UPDATE_INTERVAL).await;
        run_pending_tasks().await;
        assert!(liveness.get() > 0);
        assert!(!task.is_finished());

        tokio::time::advance(Duration::from_secs(5)).await;
        task.await.expect("idle sleep should complete");
    }

    #[test]
    fn raw_dispatch_scan_distinguishes_full_and_final_pages() {
        let full_page = RawDispatchReconciliationResult {
            candidate_count: RAW_DISPATCH_RECONCILIATION_BATCH_SIZE as usize,
            ..Default::default()
        };
        let final_page = RawDispatchReconciliationResult {
            candidate_count: 1,
            ..Default::default()
        };

        assert!(!raw_dispatch_reconciliation_scan_complete(&full_page));
        assert!(raw_dispatch_reconciliation_scan_complete(&final_page));
    }

    #[tokio::test(start_paused = true)]
    async fn raw_dispatch_scan_advances_only_after_a_full_page() {
        let started_at = Instant::now();
        let mut scan = RawDispatchScan::new(10, 250, started_at)
            .expect("frontier beyond the cursor should start a scan");
        let full_page = RawDispatchReconciliationResult {
            candidate_count: RAW_DISPATCH_RECONCILIATION_BATCH_SIZE as usize,
            next_after_id: 110,
            ..Default::default()
        };

        assert!(!scan.complete_page(&full_page, started_at));
        assert_eq!(scan.after_id, 110);
        assert_eq!(
            scan.next_page_at,
            instant_after(started_at, RAW_DISPATCH_RECONCILIATION_BACKLOG_SLEEP)
        );

        let final_page = RawDispatchReconciliationResult {
            candidate_count: 0,
            ..Default::default()
        };
        assert!(scan.complete_page(&final_page, scan.next_page_at));
        assert_eq!(scan.through_id, 250);
    }

    #[tokio::test(start_paused = true)]
    async fn raw_dispatch_scan_uses_an_immutable_frontier() {
        let now = Instant::now();

        assert!(RawDispatchScan::new(50, 50, now).is_none());
        let scan = RawDispatchScan::new(50, 75, now)
            .expect("new rows beyond the watermark should start a scan");
        assert_eq!(scan.after_id, 50);
        assert_eq!(scan.through_id, 75);
    }

    #[tokio::test(start_paused = true)]
    async fn failed_lane_stays_backed_off_after_global_cooldown() {
        let failure_at = Instant::now();
        let global_retry_at = instant_after(failure_at, RPC_RETRY_SLEEP_DURATION);
        let lane_retry_at = failed_lane_retry_at(failure_at);

        tokio::time::advance(RPC_RETRY_SLEEP_DURATION).await;
        let next_wake = Instant::now();

        assert_eq!(next_wake, global_retry_at);
        assert!(lane_retry_at > next_wake);
    }

    #[tokio::test(start_paused = true)]
    async fn discovery_and_completeness_scans_share_one_slot() {
        let now = Instant::now();
        let active_scan = RawDispatchScan::new(0, 10, now);

        assert!(raw_dispatch_scan_slot_available(None, None));
        assert!(!raw_dispatch_scan_slot_available(active_scan, None));
        assert!(!raw_dispatch_scan_slot_available(None, active_scan));
    }

    #[tokio::test(start_paused = true)]
    async fn active_scan_ignores_overdue_blocked_lane_deadline() {
        let started_at = Instant::now();
        let mut schedule = RawDispatchReconciliationSchedule::new(0, started_at, started_at);
        tokio::time::advance(RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP).await;
        let now = Instant::now();

        schedule.start_full_sweep(200, now);
        let sweep = schedule
            .full_sweep
            .expect("full sweep should own scan slot");
        assert_eq!(schedule.discovery_delay(now), Duration::MAX);
        assert_eq!(schedule.full_sweep_delay(now), Duration::ZERO);

        schedule.full_sweep = Some(RawDispatchScan {
            next_page_at: instant_after(now, RAW_DISPATCH_RECONCILIATION_BACKLOG_SLEEP),
            ..sweep
        });
        assert_eq!(
            schedule.full_sweep_delay(now),
            RAW_DISPATCH_RECONCILIATION_BACKLOG_SLEEP
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reconciliation_schedule_preserves_progress_and_yields_failed_lanes() {
        let started_at = Instant::now();
        let mut schedule = RawDispatchReconciliationSchedule::new(50, started_at, started_at);

        schedule.defer_retry_lane(started_at);
        tokio::time::advance(RPC_RETRY_SLEEP_DURATION).await;
        let after_global_cooldown = Instant::now();
        assert!(schedule.retry_not_before > after_global_cooldown);

        schedule.start_full_sweep(100, after_global_cooldown);
        assert!(!schedule.scan_slot_available());
        assert!(schedule.discovery_scan.is_none());
        let sweep = schedule.full_sweep.expect("sweep should be active");

        schedule.defer_sweep_page(sweep, after_global_cooldown);
        let deferred = schedule
            .full_sweep
            .expect("failed sweep should retain its cursor");
        assert_eq!(deferred.after_id, sweep.after_id);
        assert_eq!(deferred.through_id, sweep.through_id);

        let final_page = RawDispatchReconciliationResult::default();
        schedule.complete_full_sweep_page(deferred, &final_page, deferred.next_page_at);
        assert!(schedule.full_sweep.is_none());
        assert_eq!(schedule.discovery_watermark, 100);
        assert!(schedule.scans_are_serialized());
    }

    #[test]
    fn raw_dispatch_initial_delay_is_stable_and_bounded() {
        let ethereum_delay = raw_dispatch_reconciliation_initial_delay(1);

        assert_eq!(ethereum_delay, raw_dispatch_reconciliation_initial_delay(1));
        assert!(ethereum_delay < RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP);
        assert_ne!(
            ethereum_delay,
            raw_dispatch_reconciliation_initial_delay(10)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn backed_off_final_page_wait_updates_liveness_and_bounds_queries() {
        let liveness = IntGauge::new("test_backoff_liveness", "test backoff liveness")
            .expect("test gauge should be valid");
        let task_liveness = liveness.clone();
        let query_count = Arc::new(AtomicUsize::new(0));
        let task_query_count = query_count.clone();
        let task = tokio::spawn(async move {
            loop {
                task_query_count.fetch_add(1, Ordering::SeqCst);
                sleep_with_liveness(RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP, &task_liveness).await;
            }
        });

        run_pending_tasks().await;
        assert_eq!(query_count.load(Ordering::SeqCst), 1);

        tokio::time::advance(LIVENESS_UPDATE_INTERVAL - Duration::from_secs(1)).await;
        run_pending_tasks().await;
        assert_eq!(liveness.get(), 0);
        assert_eq!(query_count.load(Ordering::SeqCst), 1);

        tokio::time::advance(Duration::from_secs(1)).await;
        run_pending_tasks().await;
        assert!(liveness.get() > 0);
        assert_eq!(query_count.load(Ordering::SeqCst), 1);

        tokio::time::advance(
            RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP
                .checked_sub(LIVENESS_UPDATE_INTERVAL)
                .expect("idle sleep exceeds one liveness interval"),
        )
        .await;
        run_pending_tasks().await;
        assert_eq!(query_count.load(Ordering::SeqCst), 2);

        task.abort();
    }

    fn generate_test_scraper_settings() -> ScraperSettings {
        let chains = [(
            "arbitrum".to_string(),
            ChainConf {
                domain: HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                signer: None,
                identity: None,
                submitter: Default::default(),
                estimated_block_time: Duration::from_secs_f64(1.1),
                reorg_period: ReorgPeriod::None,
                addresses: CoreContractAddresses {
                    mailbox: H256::from_slice(
                        hex::decode(
                            "000000000000000000000000598facE78a4302f11E3de0bee1894Da0b2Cb71F8",
                        )
                        .unwrap()
                        .as_slice(),
                    ),
                    interchain_gas_paymaster: H256::from_slice(
                        hex::decode(
                            "000000000000000000000000c756cFc1b7d0d4646589EDf10eD54b201237F5e8",
                        )
                        .unwrap()
                        .as_slice(),
                    ),
                    validator_announce: H256::from_slice(
                        hex::decode(
                            "0000000000000000000000001b33611fCc073aB0737011d5512EF673Bff74962",
                        )
                        .unwrap()
                        .as_slice(),
                    ),
                    merkle_tree_hook: H256::from_slice(
                        hex::decode(
                            "000000000000000000000000AD34A66Bf6dB18E858F6B686557075568c6E031C",
                        )
                        .unwrap()
                        .as_slice(),
                    ),
                },
                connection: ChainConnectionConf::Ethereum(h_eth::ConnectionConf {
                    rpc_connection: h_eth::RpcConnectionConf::Http {
                        url: Url::parse("https://sepolia-rollup.arbitrum.io/rpc").unwrap(),
                    },
                    transaction_overrides: h_eth::TransactionOverrides {
                        gas_price: None,
                        gas_limit: None,
                        max_fee_per_gas: None,
                        max_priority_fee_per_gas: None,
                        ..Default::default()
                    },
                    op_submission_config: OpSubmissionConfig {
                        batch_contract_address: None,
                        max_batch_size: 1,
                        ..Default::default()
                    },
                    consider_null_transaction_receipt: false,
                }),
                metrics_conf: PrometheusMiddlewareConf {
                    contracts: HashMap::new(),
                    chain: None,
                    rpc_role: Default::default(),
                },
                index: IndexSettings {
                    from: 0,
                    chunk_size: 1,
                    mode: IndexMode::Block,
                    idle_sleep_duration: Duration::from_secs(5),
                    configured_interval: None,
                },
                confirmations: Default::default(),
                chain_id: Default::default(),
                ignore_reorg_reports: false,
                native_token: Default::default(),
            },
        )];

        let chains = chains
            .into_iter()
            .map(|(_, conf)| (conf.domain.clone(), conf))
            .collect::<HashMap<_, _>>();

        let domains = chains
            .keys()
            .map(|domain| (domain.name().to_string(), domain.clone()))
            .collect();

        ScraperSettings {
            base: Settings {
                domains,
                chains,
                metrics_port: 5000,
                tracing: TracingConfig::default(),
            },
            db: String::new(),
            chains_to_scrape: vec![],
            ccr_routers: HashMap::new(),
        }
    }

    #[tokio::test]
    #[tracing_test::traced_test]
    async fn test_failed_build_chain_scrapers() {
        let mut settings = generate_test_scraper_settings();

        let registry = Registry::new();
        let core_metrics = Arc::new(CoreMetrics::new("scraper", 4000, registry).unwrap());
        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&core_metrics));
        let chain_metrics = ChainMetrics::test_default();

        // set the chains we want to scrape
        settings.chains_to_scrape = vec![
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
        ];

        // Create MockDatabase with mock query results
        let db = MockDatabase::new(DatabaseBackend::Postgres).append_query_results([
            // First query result
            vec![[("height", sea_orm::Value::BigInt(Some(100)))]
                .into_iter()
                .collect::<BTreeMap<_, _>>()],
        ]);
        let scraper_db = ScraperDb::with_connection(db.into_connection());

        let scrapers = Scraper::build_chain_scrapers(
            &settings,
            core_metrics,
            &chain_metrics,
            scraper_db,
            contract_sync_metrics,
        )
        .await;

        assert_eq!(scrapers.len(), 1);
        assert!(scrapers.contains_key(&(KnownHyperlaneDomain::Arbitrum as u32)));

        // Arbitrum chain should not have any errors because it's ChainConf exists
        let metric = chain_metrics
            .critical_error
            .get_metric_with_label_values(&["arbitrum"])
            .unwrap();
        assert_eq!(metric.get(), 0);

        // Ethereum chain should error because it is missing ChainConf
        let metric = chain_metrics
            .critical_error
            .get_metric_with_label_values(&["ethereum"])
            .unwrap();
        assert_eq!(metric.get(), 1);
    }
}
