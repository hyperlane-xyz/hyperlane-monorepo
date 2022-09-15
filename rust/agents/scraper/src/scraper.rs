use std::collections::HashMap;
use std::ops::Deref;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use async_trait::async_trait;
use ethers::prelude::H256;
use eyre::Result;
use sea_orm::DbConn;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{info_span, instrument, Instrument};
use tracing::instrument::Instrumented;

use abacus_base::{BaseAgent, ContractSync, ContractSyncMetrics, IndexSettings, run_all};
use abacus_core::{
    AbacusCommon, AbacusContract, ChainCommunicationError, Checkpoint, Message, Outbox,
    OutboxIndexer, OutboxState, TxOutcome,
};

use crate::settings::ScraperSettings;

mod block_cursor;

/// A message explorer scraper agent
#[derive(Debug)]
struct Scraper {
    /// A map of outbox contracts by name.
    outboxes: HashMap<String, SqlOutboxScraper>,
}

#[async_trait]
impl BaseAgent for Scraper {
    const AGENT_NAME: &'static str = "scraper";
    type Settings = ScraperSettings;

    async fn from_settings(_settings: Self::Settings) -> Result<Self>
    where
        Self: Sized,
    {
        Ok(Self { outboxes: todo!() })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let tasks = self
            .outboxes
            .iter()
            .map(|(name, outbox)| {
                let span = info_span!("OutboxContractSync", %name, self = ?outbox);
                let syncer = outbox.clone().sync();
                tokio::spawn(syncer).instrument(span)
            })
            .collect();

        run_all(tasks)
    }
}

impl Scraper {}

const MESSAGES_LABEL: &str = "messages";

#[derive(Debug, Clone)]
struct SqlOutboxScraper {
    db: DbConn,
    outbox: Arc<dyn Outbox>,
    indexer: Arc<dyn OutboxIndexer>,
    index_settings: IndexSettings,
    metrics: ContractSyncMetrics,
}

impl SqlOutboxScraper {
    pub fn new(
        db: DbConn,
        outbox: Arc<dyn Outbox>,
        indexer: Arc<dyn OutboxIndexer>,
        index_settings: IndexSettings,
        metrics: ContractSyncMetrics,
    ) -> Self {
        Self {
            db,
            outbox,
            indexer,
            index_settings,
            metrics,
        }
    }

    pub async fn sync(self) -> Result<()> {
        use sea_orm::prelude::*;

        let labels = [MESSAGES_LABEL, &self.outbox.chain_name()];
        let indexed_height = self.metrics.indexed_height.with_label_values(&labels);
        let stored_messages = self.metrics.stored_events.with_label_values(&labels);
        let missed_messages = self.metrics.missed_events.with_label_values(&labels);
        let message_leaf_index = self.metrics.message_leaf_index.clone();

        let mut from_block = todo!();

        loop {
            todo!()
        }
    }
}


// struct SqlContractSync<I> {
//     chain_name: String,
//     db: DbConn,
//     indexer: I,
//     index_settings: IndexSettings,
//     metrics: ContractSyncMetrics,
// }
