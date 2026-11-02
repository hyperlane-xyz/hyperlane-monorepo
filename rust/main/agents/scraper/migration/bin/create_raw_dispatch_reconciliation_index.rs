//! Build and verify a scraper index outside migration transactions.
use migration::indexes::{create_index, RAW_DISPATCH_RECONCILIATION};

mod common;

#[tokio::main(flavor = "current_thread")]
async fn main() -> eyre::Result<()> {
    create_index(&common::init().await?, RAW_DISPATCH_RECONCILIATION).await
}
