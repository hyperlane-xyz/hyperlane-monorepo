//! The checkpointer observes the Outbox contract and calls checkpoint.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

mod checkpointer;
mod settings;
mod submit;

use color_eyre::Result;

use abacus_base::Agent;

use crate::{checkpointer::Checkpointer, settings::CheckpointerSettings as Settings};

async fn _main() -> Result<()> {
    color_eyre::install()?;
    let settings = Settings::new()?;

    let agent = Checkpointer::from_settings(settings).await?;

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
