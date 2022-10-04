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

async fn _main() -> Result<()> {
    #[cfg(feature = "oneline-errors")]
    abacus_base::oneline_eyre::install()?;
    #[cfg(not(feature = "oneline-errors"))]
    color_eyre::install()?;

    let settings = settings::ValidatorSettings::new()?;

    let agent = Validator::from_settings(settings).await?;

    agent
        .as_ref()
        .settings
        .tracing
        .start_tracing(&agent.metrics())?;
    let _ = agent.metrics().clone().run_http_server();

    agent.run().await.await??;
    Ok(())
}

fn main() -> Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(_main())
}
