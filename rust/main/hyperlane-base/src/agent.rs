pub use crate::metadata::{git_sha, AgentMetadata};

use std::{env, fmt::Debug, sync::Arc};

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::config::*;
use serde::Serialize;
use tracing::info;

use crate::{
    metrics::{AgentMetrics, CoreMetrics, RuntimeMetrics},
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

/// Metadata of an agent defined from configuration
pub trait MetadataFromSettings<T>: Serialize + Sized {
    /// Create a new instance of the agent metadata from the settings
    fn build_metadata(settings: &T) -> Self;
}

/// A fundamental agent which does not make any assumptions about the tools
/// which are used.
#[async_trait]
pub trait BaseAgent: Send + Sync + Debug {
    /// The agent's name
    const AGENT_NAME: &'static str;

    /// The settings object for this agent
    type Settings: LoadableFromSettings;

    /// The agents metadata type
    type Metadata: MetadataFromSettings<Self::Settings>;

    /// Instantiate the agent from the standard settings object
    async fn from_settings(
        agent_metadata: Self::Metadata,
        settings: Self::Settings,
        metrics: Arc<CoreMetrics>,
        agent_metrics: AgentMetrics,
        chain_metrics: ChainMetrics,
        tokio_runtime_monitor: RuntimeMetrics,
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

    // Logging is not initialised at this point, so, using `println!`
    println!(
        "Agent {} starting up with version {}",
        A::AGENT_NAME,
        git_sha()
    );

    let settings = A::Settings::load()?;
    let agent_metadata = A::Metadata::build_metadata(&settings);
    let core_settings: &Settings = settings.as_ref();

    let metrics = settings.as_ref().metrics(A::AGENT_NAME)?;
    let task_monitor = tokio_metrics::TaskMonitor::new();
    let tokio_server = core_settings.tracing.start_tracing(&metrics)?;
    let agent_metrics = AgentMetrics::new(&metrics)?;
    let chain_metrics = ChainMetrics::new(&metrics)?;
    let runtime_metrics = RuntimeMetrics::new(&metrics, task_monitor)?;
    let agent = A::from_settings(
        agent_metadata,
        settings,
        metrics.clone(),
        agent_metrics,
        chain_metrics,
        runtime_metrics,
        tokio_server,
    )
    .await?;

    // This await will only end if a panic happens. We won't crash, but instead gracefully shut down
    agent.run().await;
    info!(agent = A::AGENT_NAME, "Shutting down agent...");
    Ok(())
}
