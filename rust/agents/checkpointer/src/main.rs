//! The checkpointer observes the Outbox contract and calls checkpoint.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use eyre::Result;

use abacus_base::Agent;

use crate::checkpointer::Checkpointer;

mod checkpointer;
mod settings;
mod submit;

async fn _main() -> Result<()> {
    #[cfg(feature = "oneline-errors")]
    abacus_base::oneline_eyre::install()?;
    #[cfg(not(feature = "oneline-errors"))]
    color_eyre::install()?;

    let settings = settings::CheckpointerSettings::new()?;

    let agent = Checkpointer::from_settings(settings).await?;

    agent
        .as_ref()
        .settings
        .tracing
        .start_tracing(&agent.metrics())?;
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
