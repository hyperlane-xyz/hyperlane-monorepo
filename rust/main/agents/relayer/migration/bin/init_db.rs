//! Apply pending diagnostics migrations using owner credentials in DATABASE_URL.
use std::{env, time::Duration};

use message_activity_migration::{Migrator, MigratorTrait};
use sea_orm_migration::sea_orm::{ConnectOptions, Database};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), &'static str> {
    let url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL must be set")?;
    let mut options = ConnectOptions::new(url);
    options
        .max_connections(1)
        .connect_timeout(Duration::from_secs(20))
        .sqlx_logging(false);
    // Database errors can contain credentials; do not print their raw contents.
    let db = Database::connect(options)
        .await
        .map_err(|_| "Could not connect to diagnostics database; check configuration and access")?;
    Migrator::up(&db, None)
        .await
        .map_err(|_| "Diagnostics migration failed; check database server logs")?;
    println!("Diagnostics database migrations are up to date.");
    Ok(())
}
