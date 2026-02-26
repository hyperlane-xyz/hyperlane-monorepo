use std::{env, time::Duration};

use migration::sea_orm::{Database, DatabaseConnection};
pub use migration::{DbErr, Migrator, MigratorTrait as _};
use sea_orm::ConnectOptions;

const LOCAL_DATABASE_URL: &str = "postgresql://postgres:47221c18c610@localhost:5432/postgres";
const CONNECT_TIMEOUT: u64 = 20;
const MAX_RETRIES: u32 = 10;
const RETRY_DELAY_SECS: u64 = 3;

pub fn url() -> String {
    env::var("DATABASE_URL").unwrap_or_else(|_| LOCAL_DATABASE_URL.into())
}

pub async fn init() -> Result<DatabaseConnection, DbErr> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_test_writer()
        .init();

    let url = url();
    // Redact password from URL for logging (postgresql://user:pass@host -> postgresql://user:***@host)
    let redacted = url
        .find("://")
        .and_then(|scheme_end| {
            let after_scheme = scheme_end + 3;
            let colon = url[after_scheme..].find(':')? + after_scheme;
            let at = url[colon..].find('@')? + colon;
            Some(format!("{}***{}", &url[..colon + 1], &url[at..]))
        })
        .unwrap_or_else(|| url.clone());
    println!("Connecting to {redacted}");

    let mut last_err = None;
    for attempt in 1..=MAX_RETRIES {
        let mut options: ConnectOptions = url.clone().into();
        options.connect_timeout(Duration::from_secs(CONNECT_TIMEOUT));
        match Database::connect(options).await {
            Ok(db) => return Ok(db),
            Err(e) => {
                last_err = Some(e);
                if attempt < MAX_RETRIES {
                    println!(
                        "Connection attempt {attempt}/{MAX_RETRIES} failed: {}, retrying in {RETRY_DELAY_SECS}s...",
                        last_err.as_ref().unwrap()
                    );
                    tokio::time::sleep(Duration::from_secs(RETRY_DELAY_SECS)).await;
                }
            }
        }
    }
    Err(last_err.expect("at least one connection attempt should have been made"))
}
