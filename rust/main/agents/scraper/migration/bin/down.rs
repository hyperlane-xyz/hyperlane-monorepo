//! Downgrade database.
use std::env;

use common::*;

mod common;

#[tokio::main]
async fn main() -> Result<(), DbErr> {
    let args: Vec<String> = env::args().collect();
    let steps = args
        .get(1)
        .expect("steps are required")
        .parse()
        .expect("steps to be u32");

    let db = init().await?;

    Migrator::down(&db, Some(steps)).await?;

    Ok(())
}
