//! Build and verify a scraper index outside migration transactions.
use migration::indexes::{create_index, DELIVERY_SCOPE};

mod common;

#[tokio::main(flavor = "current_thread")]
async fn main() -> eyre::Result<()> {
    create_index(&common::init().await?, DELIVERY_SCOPE).await
}
