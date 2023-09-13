use std::{env, fmt::Debug, sync::Arc};

use async_trait::async_trait;
use eyre::{Report, Result};
use futures_util::future::select_all;
use hyperlane_core::config::*;
use tokio::task::JoinHandle;
use tracing::{debug_span, instrument::Instrumented, Instrument};

use crate::{metrics::CoreMetrics, settings::Settings};

/// Properties shared across all hyperlane agents
#[derive(Debug)]
pub struct HyperlaneAgentCore {
    /// Prometheus metrics
    pub metrics: Arc<CoreMetrics>,
    /// Settings this agent was created with
    pub settings: Settings,
}

/// Settings of an agent defined from configuration
pub trait LoadableFromSettings: AsRef<Settings> + Sized {
    /// Create a new instance of these settings by reading the configs and env
    /// vars.
    fn load() -> ConfigResult<Self>;
}

/// A fundamental agent which does not make any assumptions about the tools
/// which are used.
#[async_trait]
pub trait BaseAgent: Send + Sync + Debug {
    /// The agent's name
    const AGENT_NAME: &'static str;

    /// The settings object for this agent
    type Settings: LoadableFromSettings;

    /// Instantiate the agent from the standard settings object
    async fn from_settings(settings: Self::Settings, metrics: Arc<CoreMetrics>) -> Result<Self>
    where
        Self: Sized;

    /// Start running this agent.
    #[allow(clippy::async_yields_async)]
    async fn run(self) -> Instrumented<JoinHandle<Result<()>>>;
}

/// Call this from `main` to fully initialize and run the agent for its entire
/// lifecycle. This assumes only a single agent is being run. This will
/// initialize the metrics server and tracing as well.
pub async fn agent_main<A: BaseAgent>() -> Result<()> {
    if env::var("ONELINE_BACKTRACES")
        .map(|v| v.to_lowercase())
        .as_deref()
        == Ok("true")
    {
        #[cfg(feature = "oneline-errors")]
        crate::oneline_eyre::install()?;
        #[cfg(not(feature = "oneline-errors"))]
        panic!("The oneline errors feature was not included");
    } else {
        #[cfg(feature = "color_eyre")]
        color_eyre::install()?;
    }

    let settings = A::Settings::load()?;
    let core_settings: &Settings = settings.as_ref();

    let metrics = settings.as_ref().metrics(A::AGENT_NAME)?;
    core_settings.tracing.start_tracing(&metrics)?;
    let agent = A::from_settings(settings, metrics.clone()).await?;
    metrics.run_http_server();

    agent.run().await.await?
}

/// Utility to run multiple tasks and shutdown if any one task ends.
#[allow(clippy::unit_arg, unused_must_use)]
pub fn run_all(
    tasks: Vec<Instrumented<JoinHandle<Result<(), Report>>>>,
) -> Instrumented<JoinHandle<Result<()>>> {
    debug_assert!(!tasks.is_empty(), "No tasks submitted");
    let span = debug_span!("run_all");
    tokio::spawn(async move {
        let (res, _, remaining) = select_all(tasks).await;

        for task in remaining.into_iter() {
            let t = task.into_inner();
            t.abort();
            t.await;
        }

        res?
    })
    .instrument(span)
}
