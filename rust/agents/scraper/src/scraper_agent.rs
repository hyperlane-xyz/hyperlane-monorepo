use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use eyre::WrapErr;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;
use tracing::{info_span, trace, Instrument};

use abacus_base::{
    run_all, BaseAgent, ChainSetup, ContractSyncMetrics, CoreMetrics, DomainSettings,
    InboxAddresses, IndexSettings,
};
use abacus_core::{AbacusChain, Inbox};

use crate::chain_scraper::{Local, Remote, SqlChainScraper};
use crate::db::{delivered_message_linker, ScraperDb};
use crate::settings::ScraperSettings;

/// A message explorer scraper agent
#[derive(Debug)]
#[allow(unused)]
pub struct Scraper {
    db: DbConn,
    metrics: Arc<CoreMetrics>,
    /// A map of scrapers by domain.
    scrapers: HashMap<u32, SqlChainScraper>,
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
        let db = ScraperDb::connect(&settings.app.db).await?;

        // so the challenge here is that the config files were written in a way that
        // makes a lot of sense for relayers but not a lot of sense for scraping
        // all data from a given chain at a time...
        //
        // Basically the format provided is Outbox + all destination Inboxes that
        // messages from the outbox will get written to.
        //
        // Instead, we want the Outbox + all Inboxes that are on the same local chain.

        // outboxes by their local_domain
        let mut locals: HashMap<u32, Local> = HashMap::new();
        // index settings for each domain
        let mut index_settings: HashMap<u32, IndexSettings> = HashMap::new();
        // inboxes by their local_domain, remote_domain
        let mut remotes: HashMap<u32, HashMap<u32, Remote>> = HashMap::new();

        for (outbox_domain, chain_config) in settings.chains.into_iter() {
            let ctx = || format!("Loading chain {}", chain_config.outbox.name);
            if let Some(local) = Self::load_local(&chain_config, &metrics)
                .await
                .with_context(ctx)?
            {
                trace!(domain = outbox_domain, "Created outbox and outbox indexer");
                assert_eq!(local.outbox.local_domain(), outbox_domain);
                locals.insert(outbox_domain, local);
            }

            for (_, inbox_config) in chain_config.inboxes.iter() {
                if let Some(remote) = Self::load_remote(&chain_config, inbox_config, &metrics)
                    .await
                    .with_context(ctx)?
                {
                    let inbox_remote_domain = remote.inbox.remote_domain();
                    let inbox_local_domain = remote.inbox.local_domain();
                    assert_eq!(inbox_remote_domain, outbox_domain);
                    assert_ne!(
                        inbox_local_domain, outbox_domain,
                        "Attempting to load inbox for the chain we are on"
                    );

                    trace!(
                        local_domain = inbox_local_domain,
                        remote_domain = inbox_remote_domain,
                        "Created inbox and inbox indexer"
                    );
                    remotes
                        .entry(inbox_local_domain)
                        .or_default()
                        .insert(inbox_remote_domain, remote);
                }
            }

            index_settings.insert(outbox_domain, chain_config.index);
        }

        let contract_sync_metrics = ContractSyncMetrics::new(metrics.clone());
        let mut scrapers: HashMap<u32, SqlChainScraper> = HashMap::new();
        for (local_domain, local) in locals.into_iter() {
            let remotes = remotes.remove(&local_domain).unwrap_or_default();
            let index_settings = index_settings
                .remove(&local_domain)
                .expect("Missing index settings for domain");

            let scraper = SqlChainScraper::new(
                db.clone(),
                local,
                remotes,
                &index_settings,
                contract_sync_metrics.clone(),
            )
            .await?;
            scrapers.insert(local_domain, scraper);
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
                let syncer = scraper.clone().sync();
                tokio::spawn(syncer).instrument(span)
            })
            .chain(
                // TODO: remove this during refactoring if we no longer need it
                [tokio::spawn(delivered_message_linker(self.db.clone()))
                    .instrument(info_span!("DeliveredMessageLinker"))]
                .into_iter(),
            )
            .collect();

        run_all(tasks)
    }
}

impl Scraper {
    async fn load_local(
        config: &DomainSettings,
        metrics: &Arc<CoreMetrics>,
    ) -> eyre::Result<Option<Local>> {
        Ok(
            if config
                .outbox
                .disabled
                .as_ref()
                .and_then(|d| d.parse::<bool>().ok())
                .unwrap_or(false)
            {
                None
            } else {
                let ctx = || format!("Loading local {}", config.outbox.name);
                Some(Local {
                    provider: config.try_provider(metrics).await.with_context(ctx)?.into(),
                    outbox: config.try_outbox(metrics).await.with_context(ctx)?.into(),
                    indexer: config
                        .try_outbox_indexer(metrics)
                        .await
                        .with_context(ctx)?
                        .into(),
                })
            },
        )
    }

    async fn load_remote(
        config: &DomainSettings,
        inbox_config: &ChainSetup<InboxAddresses>,
        metrics: &Arc<CoreMetrics>,
    ) -> eyre::Result<Option<Remote>> {
        Ok(
            if inbox_config
                .disabled
                .as_ref()
                .and_then(|d| d.parse::<bool>().ok())
                .unwrap_or(false)
            {
                None
            } else {
                let ctx = || format!("Loading remote {}", inbox_config.name);
                Some(Remote {
                    inbox: config
                        .try_inbox(inbox_config, metrics)
                        .await
                        .with_context(ctx)?
                        .into(),
                    indexer: config
                        .try_inbox_indexer(inbox_config, metrics)
                        .await
                        .with_context(ctx)?
                        .into(),
                })
            },
        )
    }
}
