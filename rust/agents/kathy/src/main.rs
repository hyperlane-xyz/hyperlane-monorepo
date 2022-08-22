//! Kathy is chatty. She sends random messages to random recipients

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use eyre::Result;

use abacus_base::{Agent, BaseAgent};

use crate::kathy::Kathy;

mod kathy;
mod settings;

async fn _main() -> Result<()> {
    #[cfg(feature = "oneline-errors")]
    abacus_base::oneline_eyre::install()?;
    #[cfg(not(feature = "oneline-errors"))]
    color_eyre::install()?;

    let settings = settings::KathySettings::new()?;
    let agent = Kathy::from_settings(settings).await?;

    agent
        .as_ref()
        .settings
        .tracing
        .start_tracing(&agent.metrics())?;
    let _ = agent.metrics().run_http_server();

    agent.run().await.await?
}

fn main() -> Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(_main())
}
