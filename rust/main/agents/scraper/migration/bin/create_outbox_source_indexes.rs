//! Create indexes for populated outbox source tables outside the SeaORM
//! migration transaction so Postgres can build them concurrently.

use common::{init, DbErr};
use migration::sea_orm::ConnectionTrait;

mod common;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), DbErr> {
    let db = init().await?;

    db.execute_unprepared(
        r#"
        CREATE INDEX CONCURRENTLY IF NOT EXISTS message_origin_tx_id_idx
        ON message (origin_tx_id)
        "#,
    )
    .await?;

    db.execute_unprepared(
        r#"
        CREATE INDEX CONCURRENTLY IF NOT EXISTS gas_payment_tx_id_idx
        ON gas_payment (tx_id)
        "#,
    )
    .await?;

    Ok(())
}
