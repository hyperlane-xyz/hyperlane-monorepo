use std::{env, time::Duration};

use migration::sea_orm::{Database, DatabaseConnection};
pub use migration::{DbErr, Migrator, MigratorTrait as _};
use sea_orm::ConnectOptions;

const LOCAL_DATABASE_URL: &str = "postgresql://postgres:47221c18c610@localhost:5432/postgres";
const CONNECT_TIMEOUT: u64 = 20;

pub fn url() -> String {
    env::var("DATABASE_URL").unwrap_or_else(|_| LOCAL_DATABASE_URL.into())
}

pub async fn init() -> Result<DatabaseConnection, DbErr> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_test_writer()
        .init();

    let url = url();
    let mut options: ConnectOptions = url.clone().into();
    options.connect_timeout(Duration::from_secs(CONNECT_TIMEOUT));
    println!("Connecting to {url}");
    Database::connect(options).await
}
