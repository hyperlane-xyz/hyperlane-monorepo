use std::env;

use sea_orm_migration::SchemaManager;

use migration::sea_orm::Database;
use migration::{DbErr, Migrator, MigratorTrait as _};

const LOCAL_DATABASE_URL: &str = "postgresql://postgres:47221c18c610@localhost:5432";

#[tokio::main]
async fn main() -> Result<(), DbErr> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_test_writer()
        .init();

    let db =
        Database::connect(env::var("DATABASE_URL").unwrap_or_else(|_| LOCAL_DATABASE_URL.into()))
            .await?;

    // Apply all pending migrations
    // let sm = SchemaManager::new(&db);
    // for m in Migrator::migrations().iter().rev() {
    //     m.down(&sm).await?;
    // }
    Migrator::reset(&db).await?;
    Migrator::up(&db, None).await?;
    // Migrator::up(&db, None).await?;

    Ok(())
}
