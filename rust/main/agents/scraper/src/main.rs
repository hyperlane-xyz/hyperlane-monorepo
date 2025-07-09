//! The message explorer scraper is responsible for building and maintaining a
//! relational database of the Hyperlane state across blockchains to empower us and
//! our users to trace and debug messages and other system state.
//!
//! Information scrapped is predominately recoverable simply be re-scraping the
//! blockchains, however, they may be some additional "enrichment" which is only
//! practically discoverable at the time it was recorded. This additional
//! information is not critical to the functioning of the system.
//!
//! One scraper instance is run per chain and together they will be able to
//! piece together the full hyperlane system state in the relational database.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use agent::Scraper;
use eyre::Result;
use hyperlane_base::agent_main;

mod agent;
mod conversions;
mod date_time;
mod db;
mod settings;
mod store;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    // Logging is not initialised at this point, so, using `println!`
    println!("Scraper starting up...");

    agent_main::<Scraper>().await
}
