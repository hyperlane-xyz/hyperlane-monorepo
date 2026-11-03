//! Apply pending migrations, then build and verify concurrent scraper indexes.

use common::*;

mod common;

#[tokio::main(flavor = "current_thread")]
async fn main() -> eyre::Result<()> {
    let db = init().await?;

    Migrator::up(&db, None).await?;
    migration::indexes::create_indexes(&db).await?;

    Ok(())
}
