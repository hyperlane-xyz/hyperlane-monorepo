use std::{collections::HashMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use derive_more::AsRef;
use eyre::Context;
use futures::future::try_join_all;
use hyperlane_core::{rpc_clients::RPC_RETRY_SLEEP_DURATION, HyperlaneDomain};
use prometheus::IntGaugeVec;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument, trace, Instrument};

use hyperlane_base::{
    metrics::AgentMetrics, settings::IndexSettings, AgentMetadata, BaseAgent, ChainMetrics,
    ChainSpecificMetricsUpdater, ContractSyncMetrics, CoreMetrics, HyperlaneAgentCore,
    RuntimeMetrics,
};

use crate::{
    db::ScraperDb,
    reconciliation::{self, ReconciliationMetrics},
    settings::ScraperSettings,
    store::HyperlaneDbStore,
};

// Chains that fail to start keep retrying, at most this far apart, so an RPC
// outage or a pending cutover recovers without a pod restart.
const CHAIN_SETUP_MAX_RETRY_DELAY: Duration = Duration::from_secs(5 * 60);
/// A message explorer scraper agent
#[derive(Debug, AsRef)]
pub struct Scraper {
    #[as_ref]
    core: HyperlaneAgentCore,
    contract_sync_metrics: Arc<ContractSyncMetrics>,
    scrapers: HashMap<u32, ChainScraper>,
    /// Configured chains whose construction failed at startup; retried by `run`.
    unbuilt: Vec<HyperlaneDomain>,
    db: ScraperDb,
    settings: ScraperSettings,
    core_metrics: Arc<CoreMetrics>,
    agent_metrics: AgentMetrics,
    chain_metrics: ChainMetrics,
    /// Spawned once by `run`.
    runtime_metrics: Option<RuntimeMetrics>,
    raw_dispatch_unenriched_max_age: IntGaugeVec,
    receipt_oldest_pending_seconds: prometheus::GaugeVec,
    raw_dispatch_reconciliation_metrics: ReconciliationMetrics,
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
        let db = ScraperDb::connect_with_options(
            &settings.db,
            settings.db_max_connections,
            settings.db_acquire_timeout,
        )
        .await?;
        db.verify_frontier_indexes().await.wrap_err(
            "Required scraper frontier indexes are missing or invalid; rerun init-db to completion",
        )?;
        let core = settings.build_hyperlane_core(metrics.clone());

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));
        let raw_dispatch_unenriched_max_age = metrics
            .new_int_gauge(
                "raw_message_dispatch_unenriched_max_age_seconds",
                "Maximum age in seconds of raw message dispatches pending reconciliation",
                &["chain"],
            )
            .expect("failed to register raw dispatch reconciliation age metric");
        let raw_dispatch_reconciliation_metrics = ReconciliationMetrics::new(&metrics);
        let receipt_oldest_pending_seconds = metrics.new_gauge(
            "scraper_receipt_oldest_pending_seconds",
            "Age since creation of the oldest pending receipt event by ID, in seconds",
            &["chain", "event_type"],
        )?;

        let scrapers =
            Self::build_chain_scrapers(&settings, metrics.clone(), &chain_metrics, db.clone())
                .await;

        trace!(domain_count = scrapers.len(), "Created scrapers");
        let unbuilt = settings
            .chains_to_scrape
            .iter()
            .filter(|domain| !scrapers.contains_key(&domain.id()))
            .cloned()
            .collect();

        Ok(Self {
            core,
            contract_sync_metrics,
            scrapers,
            unbuilt,
            db,
            settings,
            core_metrics: metrics,
            agent_metrics,
            chain_metrics,
            runtime_metrics: Some(runtime_metrics),
            raw_dispatch_unenriched_max_age,
            receipt_oldest_pending_seconds,
            raw_dispatch_reconciliation_metrics,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(self) {
        let mut agent = self;
        let mut tasks = Vec::with_capacity(2);

        // running http server
        let server = agent
            .core
            .settings
            .server(agent.core_metrics.clone())
            .expect("Failed to create server");
        let server_task = tokio::spawn(
            async move {
                server.run();
            }
            .instrument(info_span!("Scraper server")),
        );
        tasks.push(server_task);

        if let Some(runtime_metrics) = agent.runtime_metrics.take() {
            tasks.push(runtime_metrics.spawn());
        }
        let agent = &agent;
        let chains = try_join_all(
            agent
                .scrapers
                .values()
                .map(|scraper| agent.supervise_chain(scraper)),
        );
        let unbuilt = try_join_all(
            agent
                .unbuilt
                .iter()
                .map(|domain| agent.supervise_unbuilt_chain(domain)),
        );
        if let Err(err) = tokio::try_join!(try_join_all(tasks), chains, unbuilt) {
            tracing::error!(error = ?err, "Scraper task panicked");
        }
    }
}

impl Scraper {
    /// Starts one chain, retrying failed setup with backoff instead of dropping
    /// the chain until the next restart.
    async fn supervise_chain(&self, scraper: &ChainScraper) -> Result<(), tokio::task::JoinError> {
        let mut delay = RPC_RETRY_SLEEP_DURATION;
        let mut attempt_count: u64 = 0;
        let tasks = loop {
            match self.start_chain(scraper).await {
                Ok(tasks) => break tasks,
                Err(err) => {
                    tracing::error!(?err, ?scraper.domain, attempt_count, retry_in = ?delay, "Failed to scrape chain");
                    self.chain_metrics
                        .set_critical_error(scraper.domain.name(), true);
                    sleep(delay).await;
                    delay = delay.saturating_mul(2).min(CHAIN_SETUP_MAX_RETRY_DELAY);
                    attempt_count = attempt_count.saturating_add(1);
                }
            }
        };
        self.chain_metrics
            .set_critical_error(scraper.domain.name(), false);
        try_join_all(tasks).await.map(|_| ())
    }

    /// Retries construction of a chain that failed at startup (e.g. provider or
    /// cursor setup), then supervises it like any other chain.
    async fn supervise_unbuilt_chain(
        &self,
        domain: &HyperlaneDomain,
    ) -> Result<(), tokio::task::JoinError> {
        let mut delay = RPC_RETRY_SLEEP_DURATION;
        let scraper = loop {
            sleep(delay).await;
            match Self::build_chain_scraper(
                domain,
                &self.settings,
                self.core_metrics.clone(),
                self.db.clone(),
            )
            .await
            {
                Ok(scraper) => break scraper,
                Err(err) => {
                    tracing::error!(?err, ?domain, retry_in = ?delay, "Failed to build chain scraper");
                    self.chain_metrics.set_critical_error(domain.name(), true);
                    delay = delay.saturating_mul(2).min(CHAIN_SETUP_MAX_RETRY_DELAY);
                }
            }
        };
        info!(domain = domain.name(), "built chain scraper after retry");
        self.supervise_chain(&scraper).await
    }

    async fn start_chain(&self, scraper: &ChainScraper) -> eyre::Result<Vec<JoinHandle<()>>> {
        let chain_conf = self
            .settings
            .chain_setup(&scraper.domain)
            .wrap_err("Failed to get chain config")?;
        let metrics_updater = ChainSpecificMetricsUpdater::new(
            chain_conf,
            self.core_metrics.clone(),
            self.agent_metrics.clone(),
            self.chain_metrics.clone(),
            Self::AGENT_NAME.to_string(),
        )
        .await
        .wrap_err("Failed to build metrics updater")?;
        let scraper_task = self.scrape(scraper).await?;
        Ok(vec![scraper_task, metrics_updater.spawn()])
    }

    /// Sync contract data and other blockchain with the current chain state.
    /// This will spawn long-running contract sync tasks
    #[instrument(fields(domain=%scraper.domain.name()), skip_all)]
    async fn scrape(&self, scraper: &ChainScraper) -> eyre::Result<JoinHandle<()>> {
        let store = scraper.store.clone();
        let index_settings = scraper.index_settings.clone();
        let domain = scraper.domain.clone();

        let chain_setup = self.settings.chain_setup(&domain)?;
        let mut tasks = Vec::with_capacity(3);
        tasks.push(
            crate::near_head::spawn(
                chain_setup,
                store.clone(),
                self.core_metrics.clone(),
                self.chain_metrics.clone(),
                self.contract_sync_metrics.clone(),
                self.receipt_oldest_pending_seconds.clone(),
            )
            .await?,
        );

        tasks.push(reconciliation::spawn(
            domain.clone(),
            self.contract_sync_metrics.clone(),
            self.raw_dispatch_unenriched_max_age.clone(),
            self.raw_dispatch_reconciliation_metrics.clone(),
            store.clone(),
        ));

        let ccr_task = match crate::ccr::spawn(
            &self.settings,
            domain,
            self.core_metrics.clone(),
            store,
            index_settings.clone(),
        )
        .await
        {
            Ok(task) => task,
            Err(err) => {
                // A retried setup spawns fresh workers that share this process's
                // writer ID, so the ones already running must not outlive the failure.
                for task in &tasks {
                    task.abort();
                }
                return Err(err);
            }
        };
        tasks.extend(ccr_task);

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
        );
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
    ) -> HashMap<u32, ChainScraper> {
        let mut scrapers: HashMap<u32, ChainScraper> = HashMap::new();

        for domain in settings.chains_to_scrape.iter() {
            match Self::build_chain_scraper(domain, settings, metrics.clone(), scraper_db.clone())
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
}

#[cfg(test)]
mod tests;
