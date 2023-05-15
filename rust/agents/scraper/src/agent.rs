use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use eyre::{eyre, WrapErr};
use hyperlane_base::chains::IndexSettings;
use hyperlane_base::CachingInterchainGasPaymaster;
use hyperlane_base::CachingMailbox;
use hyperlane_base::SyncType;
use itertools::Itertools;
use tokio::task::JoinHandle;
use tracing::{instrument::Instrumented, trace};

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
    contract_sync_metrics: ContractSyncMetrics,
    scrapers: HashMap<u32, ChainScraper>,
}

#[derive(Debug)]
struct ChainScraper {
    index_settings: IndexSettings,
    mailbox: CachingMailbox,
    interchain_gas_paymaster: CachingInterchainGasPaymaster,
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

        let contract_sync_metrics = ContractSyncMetrics::new(metrics.clone());
        // TODO: Key by domain
        let mut scrapers: HashMap<u32, ChainScraper> = HashMap::new();

        for domain in settings.chains_to_scrape.iter() {
            let chain_setup = settings.chain_setup(domain).expect("Missing chain config");
            let db = Arc::new(
                HyperlaneSqlDb::new(
                    db.clone(),
                    chain_setup.addresses.mailbox,
                    domain.clone(),
                    // TODO: This is probably wrong..
                    settings
                        .build_provider(domain, &*metrics.clone())
                        .await?
                        .into(),
                    &chain_setup.index.clone(),
                )
                .await?,
            );
            let mailbox = settings
                .build_caching_mailbox(domain, &*metrics.clone(), db.clone())
                .await?;
            let interchain_gas_paymaster = settings
                .build_caching_interchain_gas_paymaster(domain, &*metrics.clone(), db.clone())
                .await?;
            let index_settings = chain_setup.index.clone();
            scrapers.insert(
                domain.id(),
                ChainScraper {
                    mailbox,
                    interchain_gas_paymaster,
                    index_settings,
                },
            );
        }

        trace!(domain_count = scrapers.len(), "Created scrapers");

        Ok(Self {
            core,
            contract_sync_metrics,
            scrapers,
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
    async fn scrape(&self, domain: &u32) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        //let span = info_span!("ChainContractSync", %name, chain=%scraper.domain());
        let scraper = self.scrapers.get(&domain).unwrap();
        let index_settings = scraper.index_settings.clone();
        let sync_dispatched_messages_tasks = scraper
            .mailbox
            .sync_dispatched_messages(
                index_settings.clone(),
                SyncType::Forward,
                self.contract_sync_metrics.clone(),
            )
            .await
            .unwrap();
        let sync_delivered_messages_task = scraper
            .mailbox
            .sync_delivered_messages(
                index_settings.clone(),
                SyncType::Forward,
                self.contract_sync_metrics.clone(),
            )
            .await
            .unwrap();
        let sync_gas_payments_task = scraper
            .interchain_gas_paymaster
            .sync_gas_payments(
                index_settings.clone(),
                SyncType::Forward,
                self.contract_sync_metrics.clone(),
            )
            .await
            .unwrap();

        let mut tasks = Vec::with_capacity(
            sync_dispatched_messages_tasks.len()
                + sync_delivered_messages_task.len()
                + sync_gas_payments_task.len(),
        );

        for task in sync_dispatched_messages_tasks {
            tasks.push(task);
        }
        for task in sync_delivered_messages_task {
            tasks.push(task);
        }
        for task in sync_gas_payments_task {
            tasks.push(task);
        }
        run_all(tasks)
    }
}

impl AsRef<HyperlaneAgentCore> for Scraper {
    fn as_ref(&self) -> &HyperlaneAgentCore {
        &self.core
    }
}
