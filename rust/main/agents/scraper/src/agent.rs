use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use derive_more::AsRef;
use futures::future::try_join_all;
use hyperlane_core::{Delivery, HyperlaneDomain, HyperlaneMessage, InterchainGasPayment, H512};
use tokio::{sync::mpsc::Receiver as MpscReceiver, task::JoinHandle};
use tracing::{info, info_span, trace, Instrument};

use hyperlane_base::{
    broadcast::BroadcastMpscSender, metrics::AgentMetrics, settings::IndexSettings, AgentMetadata,
    BaseAgent, ChainMetrics, ChainSpecificMetricsUpdater, ContractSyncMetrics, ContractSyncer,
    CoreMetrics, HyperlaneAgentCore, RuntimeMetrics, SyncOptions,
};

use crate::{db::ScraperDb, settings::ScraperSettings, store::HyperlaneDbStore};

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

        let scrapers =
            Self::build_chain_scrapers(&settings, metrics.clone(), &chain_metrics, db.clone())
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

            match self.scrape(scraper).await {
                Ok(scraper_task) => {
                    tasks.push(scraper_task);
                }
                Err(err) => {
                    tracing::error!(?err, ?scraper.domain, "Failed to scrape domain");
                    self.chain_metrics
                        .set_critical_error(scraper.domain.name(), true);
                    continue;
                }
            }
            match metrics_updater.spawn() {
                Ok(task) => tasks.push(task),
                Err(err) => {
                    tracing::error!(?err, ?scraper.domain, "Failed to spawn metrics updater");
                    self.chain_metrics
                        .set_critical_error(scraper.domain.name(), true);
                    return;
                }
            }
        }
        tasks.push(self.runtime_metrics.spawn());
        if let Err(err) = try_join_all(tasks).await {
            tracing::error!(error = ?err, "Scraper task panicked");
        }
    }
}

impl Scraper {
    /// Sync contract data and other blockchain with the current chain state.
    /// This will spawn long-running contract sync tasks
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
                domain,
                self.core_metrics.clone(),
                self.contract_sync_metrics.clone(),
                store,
                index_settings.clone(),
                BroadcastMpscSender::<H512>::map_get_receiver(maybe_broadcaster.as_ref()).await,
            )
            .await?;
        tasks.push(gas_payment_indexer);

        Ok(tokio::spawn(
            async move {
                // If any of the tasks panic, we want to propagate it, so we unwrap
                try_join_all(tasks).await.unwrap();
            }
            .instrument(info_span!("Scraper Tasks")),
        ))
    }

    async fn build_chain_scraper(
        domain: &HyperlaneDomain,
        settings: &ScraperSettings,
        metrics: Arc<CoreMetrics>,
        scraper_db: ScraperDb,
    ) -> eyre::Result<ChainScraper> {
        info!(domain = domain.name(), "create chain scraper for domain");
        let chain_setup = settings.chain_setup(domain)?;
        info!(domain = domain.name(), "create HyperlaneProvider");
        let provider = settings
            .build_provider(domain, &metrics.clone())
            .await?
            .into();
        info!(domain = domain.name(), "create HyperlaneDbStore");
        let store = HyperlaneDbStore::new(
            scraper_db,
            domain.clone(),
            chain_setup.addresses.mailbox,
            chain_setup.addresses.interchain_gas_paymaster,
            provider,
            &chain_setup.index.clone(),
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

    async fn build_message_indexer(
        &self,
        domain: HyperlaneDomain,
        metrics: Arc<CoreMetrics>,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        store: HyperlaneDbStore,
        index_settings: IndexSettings,
    ) -> eyre::Result<(JoinHandle<()>, Option<BroadcastMpscSender<H512>>)> {
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
                tracing::error!(?err, ?domain, "Error syncing sequenced contract");
                err
            })?;
        let cursor = sync.cursor(index_settings.clone()).await.map_err(|err| {
            tracing::error!(?err, ?domain, "Error getting cursor");
            err
        })?;
        let maybe_broadcaser = sync.get_broadcaster();
        let task = tokio::spawn(
            async move { sync.sync("message_dispatch", cursor.into()).await }.instrument(
                info_span!("ChainContractSync", chain=%domain.name(), event="message_dispatch"),
            ),
        );
        Ok((task, maybe_broadcaser))
    }

    async fn build_delivery_indexer(
        &self,
        domain: HyperlaneDomain,
        metrics: Arc<CoreMetrics>,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        store: HyperlaneDbStore,
        index_settings: IndexSettings,
    ) -> eyre::Result<JoinHandle<()>> {
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
                tracing::error!(?err, ?domain, "Error syncing contract");
                err
            })?;

        let label = "message_delivery";
        let cursor = sync.cursor(index_settings.clone()).await.map_err(|err| {
            tracing::error!(?err, ?domain, "Error getting cursor");
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
                tracing::error!(?err, ?domain, "Error syncing contract");
                err
            })?;

        let label = "gas_payment";
        let cursor = sync.cursor(index_settings.clone()).await.map_err(|err| {
            tracing::error!(?err, ?domain, "Error getting cursor");
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
}

#[cfg(test)]
mod test {
    use std::collections::BTreeMap;
    use std::time::Duration;

    use ethers::utils::hex;
    use ethers_prometheus::middleware::PrometheusMiddlewareConf;
    use prometheus::{opts, IntGaugeVec, Registry};
    use reqwest::Url;
    use sea_orm::{DatabaseBackend, MockDatabase};

    use hyperlane_base::{
        settings::{
            ChainConf, ChainConnectionConf, CoreContractAddresses, Settings, TracingConfig,
        },
        BLOCK_HEIGHT_HELP, BLOCK_HEIGHT_LABELS, CRITICAL_ERROR_HELP, CRITICAL_ERROR_LABELS,
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
                }),
                metrics_conf: PrometheusMiddlewareConf {
                    contracts: HashMap::new(),
                    chain: None,
                },
                index: IndexSettings {
                    from: 0,
                    chunk_size: 1,
                    mode: IndexMode::Block,
                },
                ignore_reorg_reports: false,
            },
        )];

        ScraperSettings {
            base: Settings {
                chains: chains.into_iter().collect(),
                metrics_port: 5000,
                tracing: TracingConfig::default(),
            },
            db: String::new(),
            chains_to_scrape: vec![],
        }
    }

    #[tokio::test]
    #[tracing_test::traced_test]
    async fn test_failed_build_chain_scrapers() {
        let mut settings = generate_test_scraper_settings();

        let registry = Registry::new();
        let core_metrics = CoreMetrics::new("scraper", 4000, registry).unwrap();
        let chain_metrics = ChainMetrics {
            block_height: IntGaugeVec::new(
                opts!("block_height", BLOCK_HEIGHT_HELP),
                BLOCK_HEIGHT_LABELS,
            )
            .unwrap(),
            gas_price: None,
            critical_error: IntGaugeVec::new(
                opts!("critical_error", CRITICAL_ERROR_HELP),
                CRITICAL_ERROR_LABELS,
            )
            .unwrap(),
        };

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
            Arc::new(core_metrics),
            &chain_metrics,
            scraper_db,
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
