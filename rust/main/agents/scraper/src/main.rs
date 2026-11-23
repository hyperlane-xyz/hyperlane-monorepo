//! Index Hyperlane events across configured chains into PostgreSQL.
//! Near-head ingestion publishes confirmed history; independent workers enrich
//! transactions and same-chain CCR swaps for the Explorer.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(clippy::unwrap_used, clippy::panic)]
#![deny(clippy::arithmetic_side_effects)]

use agent::Scraper;
use eyre::Result;
use hyperlane_base::agent_main;

mod agent;
mod ccr;
mod conversions;
mod date_time;
mod db;
mod near_head;
mod reconciliation;
mod settings;
mod store;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    // Logging is not initialised at this point, so, using `println!`
    println!("Scraper starting up...");

    agent_main::<Scraper>().await
}
