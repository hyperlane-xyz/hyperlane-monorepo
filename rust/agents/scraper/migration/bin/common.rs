use std::env;

use migration::sea_orm::{Database, DatabaseConnection};
pub use migration::{DbErr, Migrator, MigratorTrait as _};

const LOCAL_DATABASE_URL: &str = "postgresql://postgres:47221c18c610@localhost:5432/postgres";

pub fn url() -> String {
    env::var("DATABASE_URL").unwrap_or_else(|_| LOCAL_DATABASE_URL.into())
}

pub async fn init() -> Result<DatabaseConnection, DbErr> {
    #[cfg(all(feature = "tracing", feature = "tracing-subscriber"))]
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_test_writer()
        .init();

    let url = url();
    println!("Connecting to {url}");
    Database::connect(url).await
}
