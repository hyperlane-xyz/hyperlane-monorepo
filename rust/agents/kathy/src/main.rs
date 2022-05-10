//! Kathy is chatty. She sends random messages to random recipients

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use eyre::Result;

use abacus_base::Agent;

use crate::{kathy::Kathy, settings::KathySettings as Settings};

mod kathy;
mod settings;

async fn _main() -> Result<()> {
    #[cfg(feature = "oneline-outputs")]
    abacus_base::oneline_eyre::install()?;
    #[cfg(not(feature = "oneline-outputs"))]
    color_eyre::install()?;

    let settings = Settings::new()?;

    let agent = Kathy::from_settings(settings).await?;

    agent
        .as_ref()
        .settings
        .tracing
        .start_tracing(agent.metrics().span_duration())?;
    let _ = agent.metrics().run_http_server();

    agent.run().await?
}

fn main() -> Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(_main())
}
