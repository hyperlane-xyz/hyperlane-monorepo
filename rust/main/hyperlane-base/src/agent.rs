pub use crate::metadata::AgentMetadata;

use std::{env, fmt::Debug, sync::Arc};

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::config::*;
use tracing::info;

use crate::{
    metrics::{AgentMetrics, CoreMetrics},
    settings::Settings,
    ChainMetrics,
};

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
    async fn from_settings(
        agent_metadata: AgentMetadata,
        settings: Self::Settings,
        metrics: Arc<CoreMetrics>,
        agent_metrics: AgentMetrics,
        chain_metrics: ChainMetrics,
        tokio_console_server: console_subscriber::Server,
    ) -> Result<Self>
    where
        Self: Sized;

    /// Start running this agent.
    #[allow(clippy::async_yields_async)]
    async fn run(self);
}

/// Call this from `main` to fully initialize and run the agent for its entire
/// lifecycle. This assumes only a single agent is being run. This will
/// initialize the metrics server and tracing as well.
#[allow(unexpected_cfgs)] // TODO: `rustc` 1.80.1 clippy issue
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

    // Latest git commit hash at the time when agent was built.
    // If .git was not present at the time of build,
    // the variable defaults to "VERGEN_IDEMPOTENT_OUTPUT".
    let git_sha = env!("VERGEN_GIT_SHA").to_owned();

    let agent_metadata = AgentMetadata::new(git_sha);

    let settings = A::Settings::load()?;
    let core_settings: &Settings = settings.as_ref();

    let metrics = settings.as_ref().metrics(A::AGENT_NAME)?;
    let tokio_server = core_settings.tracing.start_tracing(&metrics)?;
    let agent_metrics = AgentMetrics::new(&metrics)?;
    let chain_metrics = ChainMetrics::new(&metrics)?;
    let agent = A::from_settings(
        agent_metadata,
        settings,
        metrics.clone(),
        agent_metrics,
        chain_metrics,
        tokio_server,
    )
    .await?;

    // This await will only end if a panic happens. We won't crash, but instead gracefully shut down
    agent.run().await;
    info!(agent = A::AGENT_NAME, "Shutting down agent...");
    Ok(())
}
