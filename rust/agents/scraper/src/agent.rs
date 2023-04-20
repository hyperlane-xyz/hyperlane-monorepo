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
use hyperlane_core::config::*;
use hyperlane_core::HyperlaneDomain;

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
        chains_to_scrape: Vec<HyperlaneDomain>,
    },
    Raw {
        /// Database connection string
        db: Option<String>,
        /// Comma separated list of chains to scrape
        chainstoscrape: Option<String>,
    }
);

impl FromRawConf<'_, RawScraperSettings> for ScraperSettings {
    fn from_config_filtered(
        raw: RawScraperSettings,
        cwp: &ConfigPath,
        _filter: (),
    ) -> ConfigResult<Self> {
        let mut err = ConfigParsingError::default();

        let db = raw
            .db
            .ok_or_else(|| eyre!("Missing `db` connection string"))
            .take_err(&mut err, || cwp + "db");

        let Some(chains_to_scrape) = raw
            .chainstoscrape
            .ok_or_else(|| eyre!("Missing `chainstoscrape` list"))
            .take_err(&mut err, || cwp + "chainstoscrape")
            .map(|s| s.split(',').map(str::to_owned).collect::<Vec<_>>())
        else { return Err(err) };

        let base = raw
            .base
            .parse_config_with_filter::<Settings>(
                cwp,
                Some(&chains_to_scrape.iter().map(String::as_str).collect()),
            )
            .take_config_err(&mut err);

        let chains_to_scrape = if let Some(base) = &base {
            chains_to_scrape
                .iter()
                .filter_map(|chain| {
                    base.lookup_domain(chain)
                        .take_err(&mut err, || cwp + "chainstoscrape")
                })
                .collect()
        } else {
            vec![]
        };

        err.into_result()?;
        Ok(Self {
            base: base.unwrap(),
            db: db.unwrap(),
            chains_to_scrape,
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

        for domain in settings.chains_to_scrape.iter() {
            let chain_setup = settings.chain_setup(domain).expect("Missing chain config");
            let ctx = || format!("Loading chain {domain}");
            let local = Self::load_chain(&settings, domain, &metrics)
                .await
                .with_context(ctx)?;
            {
                trace!(%domain, "Created mailbox and indexer");
                let scraper = SqlChainScraper::new(
                    db.clone(),
                    local,
                    &chain_setup.index,
                    contract_sync_metrics.clone(),
                )
                .await?;
                scrapers.insert(domain.id(), scraper);
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
        domain: &HyperlaneDomain,
        metrics: &Arc<CoreMetrics>,
    ) -> eyre::Result<Contracts> {
        macro_rules! b {
            ($builder:ident) => {
                config
                    .$builder(domain, metrics)
                    .await
                    .with_context(|| format!("Loading chain {domain}"))?
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
