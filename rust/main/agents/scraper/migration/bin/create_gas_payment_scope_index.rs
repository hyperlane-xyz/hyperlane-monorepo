//! Build and verify a scraper index outside migration transactions.
use migration::indexes::{create_index, GAS_PAYMENT_SCOPE};

mod common;

#[tokio::main(flavor = "current_thread")]
async fn main() -> eyre::Result<()> {
    create_index(&common::init().await?, GAS_PAYMENT_SCOPE).await
}
