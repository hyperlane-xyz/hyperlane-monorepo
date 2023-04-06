use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use eyre::{eyre, WrapErr};
use tokio::task::JoinHandle;
use tracing::{info_span, instrument::Instrumented, trace, Instrument};

use hyperlane_base::{
    decl_settings, run_all, BaseAgent, ContractSyncMetrics, CoreMetrics, HyperlaneAgentCore,
    Settings,
};

use crate::chain_scraper::{Contracts, SqlChainScraper};
use crate::db::ScraperDb;

/// A message explorer scraper agent
#[derive(Debug)]
#[allow(unused)]
pub struct Scraper {
    core: HyperlaneAgentCore,
    db: ScraperDb,
    /// A map of scrapers by domain.
    scrapers: HashMap<u32, SqlChainScraper>,
}

decl_settings!(Scraper,
    Parsed {
        db: String,
        chains_to_scrape: Vec<String>,
    },
    Raw {
        /// Database connection string
        db: Option<String>,
        /// Comma separated list of chains to scrape
        chainstoscrape: Option<String>,
    }
);

impl TryFrom<RawScraperSettings> for ScraperSettings {
    type Error = eyre::Report;

    fn try_from(r: RawScraperSettings) -> Result<Self, Self::Error> {
        Ok(Self {
            base: r.base.try_into()?,
            db: r.db.expect_or_eyre("Missing `db` connection string")?,
            chains_to_scrape: r
                .chainstoscrape
                .expect_or_eyre("Missing `chainstoscrape` list")?
                .split(',')
                .map(|s| s.to_string())
                .collect(),
        })
    }
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

        let contract_sync_metrics = ContractSyncMetrics::new(metrics.clone());
        let mut scrapers: HashMap<u32, SqlChainScraper> = HashMap::new();

        for chain_name in settings.chains_to_scrape.iter() {
            let chain_setup = settings
                .chains
                .get(chain_name)
                .ok_or_else(|| eyre!("No configuration for chain {chain_name}"))?;
            let ctx = || format!("Loading chain {chain_name}");
            let local = Self::load_chain(&settings, chain_name, &metrics)
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
                let domain = (&chain_setup.domain)
                    .try_into()
                    .context("Invalid domain id")?;
                scrapers.insert(domain, scraper);
            }
        }

        trace!(domain_count = scrapers.len(), "Creating scraper");

        Ok(Self { core, db, scrapers })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let tasks = self
            .scrapers
            .iter()
            .map(|(name, scraper)| {
                let span = info_span!("ChainContractSync", %name, chain=%scraper.domain());
                tokio::spawn(scraper.clone().sync()).instrument(span)
            })
            .collect();

        run_all(tasks)
    }
}

impl Scraper {
    async fn load_chain(
        config: &Settings,
        chain_name: &str,
        metrics: &Arc<CoreMetrics>,
    ) -> eyre::Result<Contracts> {
        macro_rules! b {
            ($builder:ident) => {
                config
                    .$builder(chain_name, metrics)
                    .await
                    .with_context(|| format!("Loading chain {chain_name}"))?
                    .into()
            };
        }
        Ok(Contracts {
            provider: b!(build_provider),
            mailbox: b!(build_mailbox),
            mailbox_indexer: b!(build_mailbox_indexer),
            igp_indexer: b!(build_interchain_gas_paymaster_indexer),
        })
    }
}

impl AsRef<HyperlaneAgentCore> for Scraper {
    fn as_ref(&self) -> &HyperlaneAgentCore {
        &self.core
    }
}
