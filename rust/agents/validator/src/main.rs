//! The validator signs Outbox checkpoints that have reached finality.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use eyre::Result;

use abacus_base::BaseAgent;

use crate::validator::Validator;

mod settings;
mod submit;
mod validator;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    #[cfg(feature = "oneline-errors")]
    abacus_base::oneline_eyre::install()?;
    #[cfg(not(feature = "oneline-errors"))]
    color_eyre::install()?;

    let settings = settings::ValidatorSettings::new()?;
    let metrics = settings.base.try_into_metrics(Validator::AGENT_NAME)?;
    settings.base.tracing.start_tracing(&metrics)?;
    let agent = Validator::from_settings(settings, metrics.clone()).await?;
    let _ = metrics.run_http_server();

    agent.run().await.await??;
    Ok(())
}
