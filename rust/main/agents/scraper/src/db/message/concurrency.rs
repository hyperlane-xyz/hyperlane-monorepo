use crate::db::{ScraperDb, StorableMessage};
use hyperlane_core::{HyperlaneMessage, H256};
use migration::MigratorTrait;
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

const TEST_DOMAIN_ID: u32 = 13375;
const TEST_DESTINATION_DOMAIN_ID: u32 = 13376;

/// Overlapping writers may enrich the same row at once.
/// Their returned counts feed the same metric and must sum to one insertion.
#[tokio::test]
async fn test_concurrent_dispatch_writers_count_insertions_once() -> eyre::Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
    let connection = Database::connect(&url).await?;
    migration::Migrator::up(&connection, None).await?;
    // Widen the overlap so both writers reach the insert before either commits.
    connection
        .execute_unprepared(
            "CREATE FUNCTION slow_dispatch_insert() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$;
         CREATE TRIGGER slow_dispatch_insert BEFORE INSERT ON message
         FOR EACH ROW EXECUTE FUNCTION slow_dispatch_insert();",
        )
        .await?;
    let mailbox = H256::from_low_u64_be(123);
    let db = ScraperDb::connect(&url).await?;
    let message = HyperlaneMessage {
        version: 3,
        origin: TEST_DOMAIN_ID,
        destination: TEST_DESTINATION_DOMAIN_ID,
        ..Default::default()
    };
    let write = || {
        db.store_dispatched_messages(
            TEST_DOMAIN_ID,
            &mailbox,
            std::iter::once(StorableMessage {
                msg: message.clone(),
                txn_id: None,
                id_override: None,
            }),
        )
    };
    let (live, reconciled) = tokio::join!(write(), write());
    let row = connection
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT COUNT(*) AS count FROM message",
        ))
        .await?
        .expect("message count");
    assert_eq!(
        row.try_get::<i64>("", "count")?,
        1,
        "only one durable dispatch"
    );
    assert_eq!(live? + reconciled?, 1, "count only this writer's inserts");
    assert_eq!(write().await?, 0, "replays do not count as insertions");
    let mixed = [
        message.clone(),
        HyperlaneMessage {
            nonce: 1,
            ..message.clone()
        },
    ];
    assert_eq!(
        db.store_dispatched_messages(
            TEST_DOMAIN_ID,
            &mailbox,
            mixed.into_iter().map(|msg| StorableMessage {
                msg,
                txn_id: None,
                id_override: None,
            }),
        )
        .await?,
        1,
        "mixed batches count only their new rows"
    );
    Ok(())
}
