//! The relayer forwards signed checkpoints from the outbox to chain to inboxes
//!
//! At a regular interval, the relayer polls Outbox for signed checkpoints and
//! submits them as checkpoints on the inbox.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use eyre::Result;

use abacus_base::BaseAgent;

use crate::relayer::Relayer;

mod checkpoint_fetcher;
mod merkle_tree_builder;
mod msg;
mod prover;
mod relayer;
mod settings;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    #[cfg(feature = "oneline-errors")]
    abacus_base::oneline_eyre::install()?;
    #[cfg(not(feature = "oneline-errors"))]
    color_eyre::install()?;

    let settings = settings::RelayerSettings::new()?;
    let metrics = settings.base.try_into_metrics(Relayer::AGENT_NAME)?;
    settings.base.tracing.start_tracing(&metrics)?;
    let agent = Relayer::from_settings(settings, metrics.clone()).await?;
    let _ = metrics.run_http_server();

    let all_fut_tasks = agent.run().await;
    all_fut_tasks.await??;

    Ok(())
}
