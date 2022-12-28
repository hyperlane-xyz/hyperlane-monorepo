use std::fmt::Debug;
use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use eyre::{Report, Result};
use futures_util::future::select_all;
use hyperlane_core::{HyperlaneDomain, MultisigIsm};
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;
use tracing::{info_span, Instrument};

use hyperlane_core::db::DB;

use crate::{
    cancel_task, metrics::CoreMetrics, settings::Settings, CachingInterchainGasPaymaster,
    CachingMailbox,
};

/// Properties shared across all hyperlane agents
#[derive(Debug)]
pub struct HyperlaneAgentCore {
    /// A map of mailbox contracts by chain name
    pub mailboxes: HashMap<HyperlaneDomain, CachingMailbox>,
    /// A map of interchain gas paymaster contracts by chain name
    pub interchain_gas_paymasters: HashMap<HyperlaneDomain, CachingInterchainGasPaymaster>,
    /// A map of interchain gas paymaster contracts by chain name
    pub multisig_isms: HashMap<HyperlaneDomain, Arc<dyn MultisigIsm>>,
    /// A persistent KV Store (currently implemented as rocksdb)
    pub db: DB,
    /// Prometheus metrics
    pub metrics: Arc<CoreMetrics>,
    /// Settings this agent was created with
    pub settings: Settings,
}

/// Settings of an agent.
pub trait NewFromSettings: AsRef<Settings> + Sized {
    /// The error type returned by new on failures to parse.
    type Error: Into<Report>;

    /// Create a new instance of these settings by reading the configs and env
    /// vars.
    fn new() -> std::result::Result<Self, Self::Error>;
}

/// A fundamental agent which does not make any assumptions about the tools
/// which are used.
#[async_trait]
pub trait BaseAgent: Send + Sync + Debug {
    /// The agent's name
    const AGENT_NAME: &'static str;

    /// The settings object for this agent
    type Settings: NewFromSettings;

    /// Instantiate the agent from the standard settings object
    async fn from_settings(settings: Self::Settings, metrics: Arc<CoreMetrics>) -> Result<Self>
    where
        Self: Sized;

    /// Start running this agent.
    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>>;
}

/// A trait for an hyperlane agent.
/// Adds assumptions for the indexer and metric methods.
///
/// To use the default implementation you must `impl AsRef<HyperlaneAgentCore>`
#[async_trait]
pub trait Agent: BaseAgent {
    /// Return a handle to the DB
    fn db(&self) -> &DB;

    /// Return a reference to a Mailbox contract
    fn mailbox(&self, domain: &HyperlaneDomain) -> Option<&CachingMailbox>;

    /// Return a reference to an InterchainGasPaymaster contract
    fn interchain_gas_paymaster(
        &self,
        domain: &HyperlaneDomain,
    ) -> Option<&CachingInterchainGasPaymaster>;

    /// Return a reference to a Multisig Ism contract
    fn multisig_ism(&self, domain: &HyperlaneDomain) -> Option<&Arc<dyn MultisigIsm>>;
}

#[async_trait]
impl<B> Agent for B
where
    B: BaseAgent + AsRef<HyperlaneAgentCore>,
{
    fn db(&self) -> &DB {
        &self.as_ref().db
    }

    fn mailbox(&self, domain: &HyperlaneDomain) -> Option<&CachingMailbox> {
        self.as_ref().mailboxes.get(domain)
    }

    fn interchain_gas_paymaster(
        &self,
        domain: &HyperlaneDomain,
    ) -> Option<&CachingInterchainGasPaymaster> {
        self.as_ref().interchain_gas_paymasters.get(domain)
    }

    fn multisig_ism(&self, domain: &HyperlaneDomain) -> Option<&Arc<dyn MultisigIsm>> {
        self.as_ref().multisig_isms.get(domain)
    }
}

/// Call this from `main` to fully initialize and run the agent for its entire
/// lifecycle. This assumes only a single agent is being run. This will
/// initialize the metrics server and tracing as well.
pub async fn agent_main<A: BaseAgent>() -> Result<()> {
    #[cfg(feature = "oneline-errors")]
    crate::oneline_eyre::install()?;
    #[cfg(all(feature = "color_eyre", not(feature = "oneline-errors")))]
    color_eyre::install()?;

    let settings = A::Settings::new().map_err(|e| e.into())?;
    let core_settings: &Settings = settings.as_ref();

    let metrics = settings.as_ref().metrics(A::AGENT_NAME)?;
    core_settings.tracing.start_tracing(&metrics)?;
    let agent = A::from_settings(settings, metrics.clone()).await?;
    let _ = metrics.run_http_server();

    agent.run().await.await?
}

/// Utility to run multiple tasks and shutdown if any one task ends.
#[allow(clippy::unit_arg, unused_must_use)]
pub fn run_all(
    tasks: Vec<Instrumented<JoinHandle<Result<(), Report>>>>,
) -> Instrumented<JoinHandle<Result<()>>> {
    debug_assert!(!tasks.is_empty(), "No tasks submitted");
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
