use std::collections::HashMap;
use std::ops::Deref;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::H256;
use sea_orm::DbConn;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use abacus_base::BaseAgent;
use abacus_core::{AbacusCommon, AbacusContract, ChainCommunicationError, Checkpoint, Message, Outbox, OutboxIndexer, OutboxState, TxOutcome};

use crate::settings::ScraperSettings;

/// A message explorer scraper agent
#[derive(Debug)]
pub struct Scraper {
    outboxes: HashMap<String, SqlCachingOutbox>
}

#[async_trait]
impl BaseAgent for Scraper {
    const AGENT_NAME: &'static str = "scraper";
    type Settings = ScraperSettings;

    async fn from_settings(_settings: Self::Settings) -> eyre::Result<Self>
    where
        Self: Sized,
    {
        Ok(Self {
            outboxes: todo!()
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let tasks = self.outboxes();

        run_all(tasks)
    }
}

impl Scraper {

}

#[derive(Debug, Clone)]
struct SqlCachingOutbox {
    db: DbConn,
    outbox: Arc<dyn Outbox>,
    indexer: Arc<dyn OutboxIndexer>,
}

impl Deref for SqlCachingOutbox {
    type Target = dyn Outbox;

    fn deref(&self) -> &Self::Target {
        &self.outbox
    }
}

impl SqlCachingOutbox {

}
