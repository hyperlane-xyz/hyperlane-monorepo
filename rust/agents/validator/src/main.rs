//! The checkpointer observes the Outbox contract and calls checkpoint.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use abacus_base::Agent;
use eyre::Result;

use crate::{settings::ValidatorSettings as Settings, validator::Validator};

mod settings;
mod submit;
mod validator;

async fn _main() -> Result<()> {
    #[cfg(feature = "oneline-outputs")]
    abacus_base::oneline_eyre::install()?;
    #[cfg(not(feature = "oneline-outputs"))]
    color_eyre::install()?;

    let settings = Settings::new()?;

    let agent = Validator::from_settings(settings).await?;

    agent
        .as_ref()
        .settings
        .tracing
        .start_tracing(agent.metrics().span_duration())?;
    let _ = agent.metrics().run_http_server();

    agent.run().await??;
    Ok(())
}

fn main() -> Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(_main())
}
