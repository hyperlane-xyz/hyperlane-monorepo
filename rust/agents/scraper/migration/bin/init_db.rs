use std::env;

use migration::sea_orm::Database;
use migration::{DbErr, Migrator, MigratorTrait as _};

const LOCAL_DATABASE_URL: &str = "postgresql://postgres:47221c18c610@localhost:5432";

#[tokio::main]
async fn main() -> Result<(), DbErr> {
    #[cfg(all(feature = "tracing", feature = "tracing-subscriber"))]
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_test_writer()
        .init();

    let url = env::var("DATABASE_URL").unwrap_or_else(|_| LOCAL_DATABASE_URL.into());
    println!("Connecting to {url}");
    let db = Database::connect(url).await?;

    Migrator::down(&db, None).await?;
    Migrator::up(&db, None).await?;

    Ok(())
}
