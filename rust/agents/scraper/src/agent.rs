use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use derive_more::AsRef;
use hyperlane_base::{
    run_all, settings::IndexSettings, BaseAgent, ContractSyncMetrics, CoreMetrics,
    HyperlaneAgentCore,
};
use hyperlane_core::HyperlaneDomain;
use tokio::task::JoinHandle;
use tracing::{info_span, instrument::Instrumented, trace, Instrument};

use crate::{chain_scraper::HyperlaneSqlDb, db::ScraperDb, settings::ScraperSettings};

/// A message explorer scraper agent
#[derive(Debug, AsRef)]
#[allow(unused)]
pub struct Scraper {
    #[as_ref]
    core: HyperlaneAgentCore,
    contract_sync_metrics: Arc<ContractSyncMetrics>,
    metrics: Arc<CoreMetrics>,
    scrapers: HashMap<u32, ChainScraper>,
}

#[derive(Debug)]
struct ChainScraper {
    index_settings: IndexSettings,
    db: HyperlaneSqlDb,
    domain: HyperlaneDomain,
}

#[async_trait]
impl BaseAgent for Scraper {
    const AGENT_NAME: &'static str = "scraper";
    type Settings = ScraperSettings;

    async fn from_settings(
        settings: Self::Settings,
        metrics: Arc<CoreMetrics>,
    ) -> eyre::Result<Self>
    where
        Self: Sized,
    {
        let db = ScraperDb::connect(&settings.db).await?;
        let core = settings.build_hyperlane_core(metrics.clone());

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));
        let mut scrapers: HashMap<u32, ChainScraper> = HashMap::new();

        for domain in settings.chains_to_scrape.iter() {
            let chain_setup = settings.chain_setup(domain).expect("Missing chain config");
            let db = HyperlaneSqlDb::new(
                db.clone(),
                chain_setup.addresses.mailbox,
                domain.clone(),
                settings
                    .build_provider(domain, &metrics.clone())
                    .await?
                    .into(),
                &chain_setup.index.clone(),
            )
            .await?;
            scrapers.insert(
                domain.id(),
                ChainScraper {
                    domain: domain.clone(),
                    db,
                    index_settings: chain_setup.index.clone(),
                },
            );
        }

        trace!(domain_count = scrapers.len(), "Created scrapers");

        Ok(Self {
            core,
            metrics,
            contract_sync_metrics,
            scrapers,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(self) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let mut tasks = Vec::with_capacity(self.scrapers.len());
        for domain in self.scrapers.keys() {
            tasks.push(self.scrape(*domain).await);
        }
        run_all(tasks)
    }
}

impl Scraper {
    /// Sync contract data and other blockchain with the current chain state.
    /// This will spawn long-running contract sync tasks
    async fn scrape(&self, domain_id: u32) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let scraper = self.scrapers.get(&domain_id).unwrap();
        let db = scraper.db.clone();
        let index_settings = scraper.index_settings.clone();
        let domain = scraper.domain.clone();

        let mut tasks = Vec::with_capacity(2);
        tasks.push(
            self.build_message_indexer(
                domain.clone(),
                self.metrics.clone(),
                self.contract_sync_metrics.clone(),
                db.clone(),
                index_settings.clone(),
            )
            .await,
        );
        tasks.push(
            self.build_delivery_indexer(
                domain.clone(),
                self.metrics.clone(),
                self.contract_sync_metrics.clone(),
                db.clone(),
                index_settings.clone(),
            )
            .await,
        );
        tasks.push(
            self.build_interchain_gas_payment_indexer(
                domain,
                self.metrics.clone(),
                self.contract_sync_metrics.clone(),
                db,
                index_settings.clone(),
            )
            .await,
        );
        run_all(tasks)
    }
}

/// Create a function to spawn task that syncs contract events
macro_rules! spawn_sync_task {
    ($name:ident, $cursor: ident, $label:literal) => {
        async fn $name(
            &self,
            domain: HyperlaneDomain,
            metrics: Arc<CoreMetrics>,
            contract_sync_metrics: Arc<ContractSyncMetrics>,
            db: HyperlaneSqlDb,
            index_settings: IndexSettings,
        ) -> Instrumented<JoinHandle<eyre::Result<()>>> {
            let sync = self
                .as_ref()
                .settings
                .$name(
                    &domain,
                    &metrics.clone(),
                    &contract_sync_metrics.clone(),
                    Arc::new(db.clone()),
                )
                .await
                .unwrap();
            let cursor = sync
                .$cursor(index_settings.clone())
                .await;
                tokio::spawn(async move {
                    sync
                        .sync($label, cursor)
                        .await
                })
                .instrument(info_span!("ChainContractSync", chain=%domain.name(), event=$label))
        }
    }
}
impl Scraper {
    async fn build_message_indexer(
        &self,
        domain: HyperlaneDomain,
        metrics: Arc<CoreMetrics>,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        db: HyperlaneSqlDb,
        index_settings: IndexSettings,
    ) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let sync = self
            .as_ref()
            .settings
            .build_message_indexer(
                &domain,
                &metrics.clone(),
                &contract_sync_metrics.clone(),
                Arc::new(db.clone()),
            )
            .await
            .unwrap();
        let latest_nonce = self
            .scrapers
            .get(&domain.id())
            .unwrap()
            .db
            .last_message_nonce()
            .await
            .unwrap_or(None)
            .unwrap_or(0);
        let cursor = sync
            .forward_message_sync_cursor(index_settings.clone(), latest_nonce.saturating_sub(1))
            .await;
        tokio::spawn(async move { sync.sync("message_dispatch", cursor).await }).instrument(
            info_span!("ChainContractSync", chain=%domain.name(), event="message_dispatch"),
        )
    }

    spawn_sync_task!(
        build_delivery_indexer,
        rate_limited_cursor,
        "message_delivery"
    );
    spawn_sync_task!(
        build_interchain_gas_payment_indexer,
        rate_limited_cursor,
        "gas_payment"
    );
}
