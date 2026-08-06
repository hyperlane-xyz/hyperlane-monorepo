//! Create the raw dispatch reconciliation index outside the SeaORM migration
//! transaction so Postgres can build it concurrently.

use common::{init, DbErr};
use migration::sea_orm::ConnectionTrait;

mod common;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), DbErr> {
    let db = init().await?;

    db.execute_unprepared(
        r#"
        CREATE INDEX CONCURRENTLY IF NOT EXISTS raw_message_dispatch_reconciliation_idx
        ON raw_message_dispatch (origin_domain, origin_mailbox, id)
        WHERE msg_body IS NOT NULL
        "#,
    )
    .await?;

    Ok(())
}
