//! The message explorer scraper is responsible for building and maintaining a
//! relational database of the Abacus state across blockchains to empower us and
//! our users to trace and debug messages and other system state.
//!
//! Information scrapped is predominately recoverable simply be re-scraping the
//! blockchains, however, they may be some additional "enrichment" which is only
//! practically discoverable at the time it was recorded. This additional
//! information is not critical to the functioning of the system.
//!
//! One scraper instance is run per chain and together they will be able to
//! piece together the full abacus system state in the relational database.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

use ethers::types::H256;
use eyre::{Context, Result};

use abacus_base::BaseAgent;

use crate::scraper::Scraper;

#[allow(clippy::all)]
mod db;

mod date_time;
mod scraper;
mod settings;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    #[cfg(feature = "oneline-errors")]
    abacus_base::oneline_eyre::install()?;
    #[cfg(not(feature = "oneline-errors"))]
    color_eyre::install()?;

    let settings = settings::ScraperSettings::new()?;
    let metrics = settings.base.try_into_metrics(Scraper::AGENT_NAME)?;
    settings.base.tracing.start_tracing(&metrics)?;
    let agent = Scraper::from_settings(settings, metrics.clone()).await?;
    let _ = metrics.run_http_server();

    let all_fut_tasks = agent.run().await;
    all_fut_tasks.await??;

    Ok(())
}

fn parse_h256<T: AsRef<[u8]>>(data: T) -> Result<H256> {
    Ok(H256::from_slice(
        &hex::decode(data).context("Error decoding hash or address")?,
    ))
}

fn format_h256(data: &H256) -> String {
    hex::encode(data)
}
