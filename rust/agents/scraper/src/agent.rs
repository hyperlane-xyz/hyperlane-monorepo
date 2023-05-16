use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use eyre::{eyre, WrapErr};
use hyperlane_base::chains::IndexSettings;
use itertools::Itertools;
use tokio::task::JoinHandle;
use tracing::info_span;
use tracing::{instrument::Instrumented, trace, Instrument};

use hyperlane_base::{
    decl_settings, run_all, BaseAgent, ContractSyncMetrics, CoreMetrics, HyperlaneAgentCore,
    Settings,
};
use hyperlane_core::config::*;
use hyperlane_core::HyperlaneDomain;

use crate::chain_scraper::HyperlaneSqlDb;
use crate::db::ScraperDb;

/// A message explorer scraper agent
#[derive(Debug)]
#[allow(unused)]
pub struct Scraper {
    core: HyperlaneAgentCore,
    contract_sync_metrics: Arc<ContractSyncMetrics>,
    metrics: Arc<CoreMetrics>,
    scrapers: HashMap<u32, ChainScraper>,
}

#[derive(Debug)]
struct ChainScraper {
    index_settings: IndexSettings,
    db: Arc<HyperlaneSqlDb>,
    domain: HyperlaneDomain,
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

        let chains_to_scrape = base
            .as_ref()
            .map(|base| {
                chains_to_scrape
                    .iter()
                    .filter_map(|chain| {
                        base.lookup_domain(chain)
                            .context("Missing configuration for a chain in `chainstoscrape`")
                            .take_err(&mut err, || cwp + "chains" + chain)
                    })
                    .collect_vec()
            })
            .unwrap_or_default();

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

        let contract_sync_metrics = Arc::new(ContractSyncMetrics::new(&metrics));
        // TODO: Key by domain
        let mut scrapers: HashMap<u32, ChainScraper> = HashMap::new();

        for domain in settings.chains_to_scrape.iter() {
            let chain_setup = settings.chain_setup(domain).expect("Missing chain config");
            let db = Arc::new(
                HyperlaneSqlDb::new(
                    db.clone(),
                    chain_setup.addresses.mailbox,
                    domain.clone(),
                    settings
                        .build_provider(domain, &metrics.clone())
                        .await?
                        .into(),
                    &chain_setup.index.clone(),
                )
                .await?,
            );
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
            scrapers: scrapers,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let mut tasks = Vec::with_capacity(self.scrapers.len());
        for domain in self.scrapers.keys() {
            tasks.push(self.scrape(domain).await);
        }
        run_all(tasks)
    }
}

impl Scraper {
    /// Sync contract data and other blockchain with the current chain state.
    /// This will create a long-running task that should be spawned.
    async fn scrape(&self, domain_id: &u32) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let scraper = self.scrapers.get(&domain_id).unwrap().clone();
        let index_settings = scraper.clone().index_settings.clone();
        let db = scraper.clone().db.clone();
        let domain = scraper.clone().domain.clone();

        let mut tasks = Vec::with_capacity(2);
        let message_sync = self
            .as_ref()
            .settings
            .build_message_sync(
                &domain,
                &self.metrics.clone(),
                &self.contract_sync_metrics.clone(),
                db.clone(),
            )
            .await
            .unwrap();
        let message_cursor = message_sync
            .forward_message_sync_cursor(index_settings.clone())
            .await;
        tasks.push(
            tokio::spawn(async move {
                message_sync
                    .sync("dispatched_messages", message_cursor)
                    .await
            })
            .instrument(info_span!("ContractSync")),
        );
        let payment_sync = self
            .as_ref()
            .settings
            .build_interchain_gas_payment_sync(
                &domain,
                &self.metrics.clone(),
                &self.contract_sync_metrics.clone(),
                db.clone(),
            )
            .await
            .unwrap();
        let payment_cursor = payment_sync
            .rate_limited_cursor(index_settings.clone())
            .await;
        tasks.push(
            tokio::spawn(async move { payment_sync.sync("gas_payments", payment_cursor).await })
                .instrument(info_span!("ContractSync")),
        );
        run_all(tasks)
    }
}

impl AsRef<HyperlaneAgentCore> for Scraper {
    fn as_ref(&self) -> &HyperlaneAgentCore {
        &self.core
    }
}
