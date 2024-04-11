use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use derive_more::AsRef;
use futures::future::try_join_all;
use hyperlane_base::{
    metrics::AgentMetrics, settings::IndexSettings, BaseAgent, ChainMetrics, ContractSyncMetrics,
    ContractSyncer, CoreMetrics, HyperlaneAgentCore, MetricsUpdater,
};
use hyperlane_core::{Delivery, HyperlaneDomain, HyperlaneMessage, InterchainGasPayment};
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
    scrapers: HashMap<u32, ChainScraper>,
    settings: ScraperSettings,
    core_metrics: Arc<CoreMetrics>,
    agent_metrics: AgentMetrics,
    chain_metrics: ChainMetrics,
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
        agent_metrics: AgentMetrics,
        chain_metrics: ChainMetrics,
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
            contract_sync_metrics,
            scrapers,
            settings,
            core_metrics: metrics,
            agent_metrics,
            chain_metrics,
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
        let server_task = server.run().instrument(info_span!("Relayer server"));
        tasks.push(server_task);

        for (domain, scraper) in self.scrapers.iter() {
            tasks.push(self.scrape(*domain).await);

            let chain_conf = self.settings.chain_setup(&scraper.domain).unwrap();
            let metrics_updater = MetricsUpdater::new(
                chain_conf,
                self.core_metrics.clone(),
                self.agent_metrics.clone(),
                self.chain_metrics.clone(),
                Self::AGENT_NAME.to_string(),
            )
            .await
            .unwrap();
            tasks.push(metrics_updater.spawn());
        }
        if let Err(err) = try_join_all(tasks).await {
            tracing::error!(error = ?err, "Scraper task panicked");
        }
    }
}

impl Scraper {
    /// Sync contract data and other blockchain with the current chain state.
    /// This will spawn long-running contract sync tasks
    async fn scrape(&self, domain_id: u32) -> Instrumented<JoinHandle<()>> {
        let scraper = self.scrapers.get(&domain_id).unwrap();
        let db = scraper.db.clone();
        let index_settings = scraper.index_settings.clone();
        let domain = scraper.domain.clone();

        let mut tasks = Vec::with_capacity(2);
        tasks.push(
            self.build_message_indexer(
                domain.clone(),
                self.core_metrics.clone(),
                self.contract_sync_metrics.clone(),
                db.clone(),
                index_settings.clone(),
            )
            .await,
        );
        tasks.push(
            self.build_delivery_indexer(
                domain.clone(),
                self.core_metrics.clone(),
                self.contract_sync_metrics.clone(),
                db.clone(),
                index_settings.clone(),
            )
            .await,
        );
        tasks.push(
            self.build_interchain_gas_payment_indexer(
                domain,
                self.core_metrics.clone(),
                self.contract_sync_metrics.clone(),
                db,
                index_settings.clone(),
            )
            .await,
        );

        tokio::spawn(async move {
            // If any of the tasks panic, we want to propagate it, so we unwrap
            try_join_all(tasks).await.unwrap();
        })
        .instrument(info_span!("Scraper Tasks"))
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
    ) -> Instrumented<JoinHandle<()>> {
        let sync = self
            .as_ref()
            .settings
            .sequenced_contract_sync::<HyperlaneMessage, _>(
                &domain,
                &metrics.clone(),
                &contract_sync_metrics.clone(),
                db.into(),
            )
            .await
            .unwrap();
        let cursor = sync.cursor(index_settings.clone()).await;
        tokio::spawn(async move { sync.sync("message_dispatch", cursor).await }).instrument(
            info_span!("ChainContractSync", chain=%domain.name(), event="message_dispatch"),
        )
    }

    async fn build_delivery_indexer(
        &self,
        domain: HyperlaneDomain,
        metrics: Arc<CoreMetrics>,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        db: HyperlaneSqlDb,
        index_settings: IndexSettings,
    ) -> Instrumented<JoinHandle<()>> {
        let sync = self
            .as_ref()
            .settings
            .watermark_contract_sync::<Delivery, _>(
                &domain,
                &metrics.clone(),
                &contract_sync_metrics.clone(),
                Arc::new(db.clone()) as _,
            )
            .await
            .unwrap();

        let label = "message_delivery";
        let cursor = sync.cursor(index_settings.clone()).await;
        tokio::spawn(async move { sync.sync(label, cursor).await })
            .instrument(info_span!("ChainContractSync", chain=%domain.name(), event=label))
    }

    async fn build_interchain_gas_payment_indexer(
        &self,
        domain: HyperlaneDomain,
        metrics: Arc<CoreMetrics>,
        contract_sync_metrics: Arc<ContractSyncMetrics>,
        db: HyperlaneSqlDb,
        index_settings: IndexSettings,
    ) -> Instrumented<JoinHandle<()>> {
        let sync = self
            .as_ref()
            .settings
            .watermark_contract_sync::<InterchainGasPayment, _>(
                &domain,
                &metrics.clone(),
                &contract_sync_metrics.clone(),
                Arc::new(db.clone()),
            )
            .await
            .unwrap();

        let label = "gas_payment";
        let cursor = sync.cursor(index_settings.clone()).await;
        tokio::spawn(async move { sync.sync(label, cursor).await })
            .instrument(info_span!("ChainContractSync", chain=%domain.name(), event=label))
    }
}
