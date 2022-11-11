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

use eyre::Result;

use abacus_base::agent_main;
use agent::Scraper;

mod db;

mod agent;
mod chain_scraper;
mod conversions;
mod date_time;
mod settings;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    agent_main::<Scraper>().await
}
