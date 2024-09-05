//! Initialize a new, empty database using the migrations.

use common::*;

mod common;

#[tokio::main]
async fn main() -> Result<(), DbErr> {
    let db = init().await?;

    Migrator::up(&db, None).await?;

    Ok(())
}
