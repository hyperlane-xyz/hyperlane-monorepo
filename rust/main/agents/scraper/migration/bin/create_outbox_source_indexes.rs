//! Create indexes for populated outbox source tables outside the SeaORM
//! migration transaction so Postgres can build them concurrently.

use common::{init, DbErr};
use migration::sea_orm::{ConnectionTrait, DatabaseConnection, Statement};

mod common;

async fn create_concurrent_index(
    db: &DatabaseConnection,
    name: &str,
    create_statement: &str,
) -> Result<(), DbErr> {
    let is_valid = db
        .query_one(Statement::from_sql_and_values(
            db.get_database_backend(),
            "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)",
            [name.into()],
        ))
        .await?
        .map(|row| row.try_get::<bool>("", "indisvalid"))
        .transpose()?;

    println!(
        "Index {name}: {}",
        match is_valid {
            Some(true) => "valid",
            Some(false) => "invalid",
            None => "absent",
        }
    );
    if is_valid == Some(false) {
        db.execute_unprepared(&format!(r#"DROP INDEX CONCURRENTLY "{name}""#))
            .await?;
    }
    db.execute_unprepared(create_statement).await?;
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), DbErr> {
    let db = init().await?;

    create_concurrent_index(
        &db,
        "message_origin_tx_id_idx",
        r#"
        CREATE INDEX CONCURRENTLY IF NOT EXISTS message_origin_tx_id_idx
        ON message (origin_tx_id)
        "#,
    )
    .await?;

    create_concurrent_index(
        &db,
        "message_origin_id_idx",
        r#"
        CREATE INDEX CONCURRENTLY IF NOT EXISTS message_origin_id_idx
        ON message (origin, id)
        "#,
    )
    .await?;

    create_concurrent_index(
        &db,
        "delivered_message_domain_id_idx",
        r#"
        CREATE INDEX CONCURRENTLY IF NOT EXISTS delivered_message_domain_id_idx
        ON delivered_message (domain, id)
        "#,
    )
    .await?;

    create_concurrent_index(
        &db,
        "gas_payment_tx_id_idx",
        r#"
        CREATE INDEX CONCURRENTLY IF NOT EXISTS gas_payment_tx_id_idx
        ON gas_payment (tx_id)
        "#,
    )
    .await?;

    Ok(())
}
