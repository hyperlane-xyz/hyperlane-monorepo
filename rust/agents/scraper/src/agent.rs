use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use eyre::WrapErr;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;
use tracing::{info_span, trace, Instrument};

use abacus_base::{
    decl_settings, run_all, BaseAgent, ContractSyncMetrics, CoreMetrics, DomainSettings,
};

use crate::chain_scraper::{Contracts, SqlChainScraper};
use crate::db::ScraperDb;

/// A message explorer scraper agent
#[derive(Debug)]
#[allow(unused)]
pub struct Scraper {
    db: ScraperDb,
    metrics: Arc<CoreMetrics>,
    // TODO: Use AbacusAgentCore
    /// A map of scrapers by domain.
    scrapers: HashMap<u32, SqlChainScraper>,
}

decl_settings!(Scraper {});

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
        let db = ScraperDb::connect(&settings.app.db).await?;

        let contract_sync_metrics = ContractSyncMetrics::new(metrics.clone());
        let mut scrapers: HashMap<u32, SqlChainScraper> = HashMap::new();

        for (chain_name, chain_setup) in settings.chain.chains.iter() {
            let ctx = || format!("Loading chain {chain_name}");
            let local = Self::load_chain(&settings.chain, chain_name, &metrics)
                .await
                .with_context(ctx)?;
            {
                trace!(chain_name = chain_name, "Created mailbox and indexer");
                let scraper = SqlChainScraper::new(
                    db.clone(),
                    local,
                    &chain_setup.index,
                    contract_sync_metrics.clone(),
                )
                .await?;
                let domain = chain_setup.domain.parse().expect("invalid uint");
                scrapers.insert(domain, scraper);
            }
        }

        trace!(domain_count = scrapers.len(), "Creating scraper");

        Ok(Self {
            db,
            metrics,
            scrapers,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let tasks = self
            .scrapers
            .iter()
            .map(|(name, scraper)| {
                let span = info_span!("ChainContractSync", %name, chain = scraper.chain_name());
                tokio::spawn(scraper.clone().sync()).instrument(span)
            })
            .collect();

        run_all(tasks)
    }
}

impl Scraper {
    async fn load_chain(
        config: &DomainSettings,
        chain_name: &str,
        metrics: &Arc<CoreMetrics>,
    ) -> eyre::Result<Contracts> {
        let ctx = || format!("Loading chain {chain_name}");
        Ok(Contracts {
            provider: config
                .build_provider(chain_name, metrics)
                .await
                .with_context(ctx)?
                .into(),
            mailbox: config
                .build_mailbox(chain_name, metrics)
                .await
                .with_context(ctx)?
                .into(),
            indexer: config
                .build_mailbox_indexer(chain_name, metrics)
                .await
                .with_context(ctx)?
                .into(),
        })
    }
}
