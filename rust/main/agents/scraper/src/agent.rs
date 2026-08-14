use std::{
    collections::HashMap,
    panic::AssertUnwindSafe,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use derive_more::AsRef;
use futures::{future::try_join_all, FutureExt};
use hyperlane_core::{rpc_clients::RPC_RETRY_SLEEP_DURATION, HyperlaneDomain};
use prometheus::IntGaugeVec;
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info, info_span, instrument, trace, warn, Instrument};

use hyperlane_base::{
    metrics::AgentMetrics, settings::IndexSettings, AgentMetadata, BaseAgent, ChainMetrics,
    ChainSpecificMetricsUpdater, ContractSyncMetrics, CoreMetrics, HyperlaneAgentCore,
    RuntimeMetrics,
};

use crate::{
    db::ScraperDb,
    settings::ScraperSettings,
    shared_chain_indexer::{ChainEventHandler, SharedChainIndexer, TypedChainEventHandler},
    store::{HyperlaneDbStore, RawDispatchRetryBackoff},
};

const CURSOR_INSTANTIATION_ATTEMPTS: usize = 10;
const RAW_DISPATCH_RECONCILIATION_BATCH_SIZE: u64 = 100;
const RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP: Duration = Duration::from_secs(60);
const RAW_DISPATCH_RECONCILIATION_BACKLOG_SLEEP: Duration = Duration::from_secs(2);

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
        let chain_setup = self.as_ref().settings.chain_setup(&domain)?;
        let ccr_to_erc20 = self
            .settings
            .ccr_routers
            .get(&domain.id())
            .cloned()
            .unwrap_or_default();

        let mut handlers: Vec<Arc<dyn ChainEventHandler>> = Vec::new();
        let chain_name = domain.name();
        let message_indexer = chain_setup
            .build_message_indexer(&self.core_metrics, true)
            .await?;
        handlers.push(Arc::new(TypedChainEventHandler::new(
            "message_dispatch",
            message_indexer,
            store.clone(),
            &self.contract_sync_metrics.stored_events,
            chain_name,
        )));

        let delivery_indexer = chain_setup
            .build_delivery_indexer(&self.core_metrics, true)
            .await?;
        handlers.push(Arc::new(TypedChainEventHandler::new(
            "message_delivery",
            delivery_indexer,
            store.clone(),
            &self.contract_sync_metrics.stored_events,
            chain_name,
        )));

        let gas_payment_indexer = chain_setup
            .build_interchain_gas_payment_indexer(&self.core_metrics, true)
            .await?;
        handlers.push(Arc::new(TypedChainEventHandler::new(
            "gas_payment",
            gas_payment_indexer,
            store.clone(),
            &self.contract_sync_metrics.stored_events,
            chain_name,
        )));

        if !ccr_to_erc20.is_empty() {
            if let Some(ccr_indexer) = chain_setup
                .build_ccr_swap_indexer(&self.core_metrics, domain.id(), ccr_to_erc20)
                .await?
            {
                handlers.push(Arc::new(TypedChainEventHandler::new(
                    "ccr_swap",
                    ccr_indexer,
                    store.clone(),
                    &self.contract_sync_metrics.stored_events,
                    chain_name,
                )));
            }
        }

        let shared_indexer = SharedChainIndexer::new(
            domain.clone(),
            store.cursor(),
            index_settings.clone(),
            self.contract_sync_metrics.clone(),
            handlers,
        )?;

        let mut tasks = Vec::with_capacity(2);
        tasks.push(tokio::spawn(
            async move { shared_indexer.run().await }
                .instrument(info_span!("SharedChainScraper", chain=%domain.name())),
        ));

        tasks.push(self.build_raw_dispatch_reconciler(
            domain.clone(),
            self.contract_sync_metrics.clone(),
            self.raw_dispatch_unenriched_max_age.clone(),
            store.clone(),
        ));

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
            chain_setup.addresses.mailbox,
            chain_setup.addresses.interchain_gas_paymaster,
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

    fn build_raw_dispatch_reconciler(
        &self,
        domain: HyperlaneDomain,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        raw_dispatch_unenriched_max_age: IntGaugeVec,
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
                let mut next_after_id = 0;
                let mut retry_backoff = RawDispatchRetryBackoff::default();
                let mut max_age_seen_this_scan = 0_u64;

                loop {
                    liveness_metric.set(
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map(|duration| duration.as_secs() as i64)
                            .unwrap_or_default(),
                    );

                    let result = AssertUnwindSafe(store.reconcile_raw_message_dispatches(
                        next_after_id,
                        RAW_DISPATCH_RECONCILIATION_BATCH_SIZE,
                        &mut retry_backoff,
                    ))
                    .catch_unwind()
                    .await;

                    match result {
                        Ok(Ok(result)) if result.candidate_count == 0 && next_after_id > 0 => {
                            next_after_id = 0;
                            max_age_seen_this_scan = 0;
                            sleep(RAW_DISPATCH_RECONCILIATION_BACKLOG_SLEEP).await;
                        }
                        Ok(Ok(result)) if result.candidate_count == 0 => {
                            max_age_metric.set(0);
                            max_age_seen_this_scan = 0;
                            sleep(RAW_DISPATCH_RECONCILIATION_IDLE_SLEEP).await;
                        }
                        Ok(Ok(result)) => {
                            next_after_id = result.next_after_id;
                            max_age_seen_this_scan =
                                max_age_seen_this_scan.max(result.max_unenriched_age_seconds);
                            max_age_metric
                                .set(max_age_seen_this_scan.try_into().unwrap_or(i64::MAX));
                            stored_events_metric.inc_by(result.stored_count.into());
                            info!(
                                candidates = result.candidate_count,
                                attempted = result.attempted_count,
                                skipped_backoff = result.skipped_backoff_count,
                                stored = result.stored_count,
                                next_after_id,
                                max_unenriched_age_seconds = max_age_seen_this_scan,
                                domain = domain_name,
                                "Reconciled raw message dispatches"
                            );
                            sleep(RAW_DISPATCH_RECONCILIATION_BACKLOG_SLEEP).await;
                        }
                        Ok(Err(err)) => {
                            warn!(
                                ?err,
                                domain = domain_name,
                                "Failed to reconcile raw message dispatches"
                            );
                            sleep(RPC_RETRY_SLEEP_DURATION).await;
                        }
                        Err(_) => {
                            warn!(
                                domain = domain_name,
                                "Raw message dispatch reconciliation panicked; retrying"
                            );
                            sleep(RPC_RETRY_SLEEP_DURATION).await;
                        }
                    }
                }
            }
            .instrument(info_span!("RawDispatchReconciliation", chain=%span_domain_name)),
        )
    }
}

#[cfg(test)]
mod test {
    use std::collections::BTreeMap;

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
