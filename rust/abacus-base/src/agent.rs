use crate::{
    cancel_task,
    metrics::CoreMetrics,
    settings::{IndexSettings, Settings},
    CachingInbox, CachingOutbox,
};
use abacus_core::db::DB;
use async_trait::async_trait;
use color_eyre::{Report, Result};
use futures_util::future::select_all;
use tracing::instrument::Instrumented;
use tracing::{info_span, Instrument};

use std::{collections::HashMap, sync::Arc};
use tokio::task::JoinHandle;

/// Properties shared across all abacus agents
#[derive(Debug)]
pub struct AbacusAgentCore {
    /// A boxed Outbox
    pub outbox: Arc<CachingOutbox>,
    /// A map of boxed Inboxes
    pub inboxes: HashMap<String, Arc<CachingInbox>>,
    /// A persistent KV Store (currently implemented as rocksdb)
    pub db: DB,
    /// Prometheus metrics
    pub metrics: Arc<CoreMetrics>,
    /// The height at which to start indexing the Outbox
    pub indexer: IndexSettings,
    /// Settings this agent was created with
    pub settings: crate::settings::Settings,
}

/// A trait for an abacus agent
#[async_trait]
pub trait Agent: Send + Sync + std::fmt::Debug + AsRef<AbacusAgentCore> {
    /// The agent's name
    const AGENT_NAME: &'static str;

    /// The settings object for this agent
    type Settings: AsRef<Settings>;

    /// Instantiate the agent from the standard settings object
    async fn from_settings(settings: Self::Settings) -> Result<Self>
    where
        Self: Sized;

    /// Return a handle to the metrics registry
    fn metrics(&self) -> Arc<CoreMetrics> {
        self.as_ref().metrics.clone()
    }

    /// Return a handle to the DB
    fn db(&self) -> DB {
        self.as_ref().db.clone()
    }

    /// Return a reference to a outbox contract
    fn outbox(&self) -> Arc<CachingOutbox> {
        self.as_ref().outbox.clone()
    }

    /// Get a reference to the inboxes map
    fn inboxes(&self) -> &HashMap<String, Arc<CachingInbox>> {
        &self.as_ref().inboxes
    }

    /// Get a reference to a inbox by its name
    fn inbox_by_name(&self, name: &str) -> Option<Arc<CachingInbox>> {
        self.inboxes().get(name).map(Clone::clone)
    }

    /// Run tasks
    #[allow(clippy::unit_arg, unused_must_use)]
    fn run_all(
        &self,
        tasks: Vec<Instrumented<JoinHandle<Result<(), Report>>>>,
    ) -> Instrumented<JoinHandle<Result<()>>>
    where
        Self: Sized + 'static,
    {
        let span = info_span!("run_all");
        tokio::spawn(async move {
            let (res, _, remaining) = select_all(tasks).await;

            for task in remaining.into_iter() {
                cancel_task!(task);
            }

            res?
        })
        .instrument(span)
    }
}
