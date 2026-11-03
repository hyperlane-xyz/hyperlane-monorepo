//! Single-statement atomicity and multi-chunk transaction boundaries.
use hyperlane_core::{HyperlaneMessage, H256};
use migration::MigratorTrait;
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, MockDatabase, MockExecResult};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use super::{ScraperDb, StorableMessage};

fn messages(count: u32) -> Vec<HyperlaneMessage> {
    (0..count)
        .map(|nonce| HyperlaneMessage {
            version: 3,
            nonce,
            origin: 1,
            destination: 1,
            body: vec![1],
            ..Default::default()
        })
        .collect()
}

async fn store(db: &ScraperDb, messages: &[HyperlaneMessage]) -> eyre::Result<u64> {
    db.store_dispatched_messages(
        1,
        &H256::zero(),
        messages.iter().cloned().map(|msg| StorableMessage {
            msg,
            txn_id: None,
            id_override: None,
        }),
    )
    .await
}

#[tokio::test]
async fn dispatch_statement_counts_preserve_multi_chunk_transactions() {
    for count in [0u32, 1, 3250, 3251] {
        let chunks = count.div_ceil(3250);
        let db = ScraperDb::with_connection(
            MockDatabase::new(DatabaseBackend::Postgres)
                .append_exec_results((0..chunks).map(|i| MockExecResult {
                    last_insert_id: 0,
                    rows_affected: u64::from((count - i * 3250).min(3250)),
                }))
                .into_connection(),
        );
        assert_eq!(
            store(&db, &messages(count)).await.unwrap(),
            u64::from(count)
        );
        let log = db.0.into_transaction_log();
        let sql: Vec<_> = log
            .iter()
            .flat_map(|t| t.statements())
            .map(|s| s.sql.as_str())
            .collect();
        if count == 0 {
            assert!(sql.is_empty());
        } else {
            assert_eq!(sql.len(), chunks as usize + 2);
            assert_eq!(sql[0], "BEGIN");
            assert!(sql[1..=chunks as usize]
                .iter()
                .all(|s| s.starts_with("INSERT")));
            assert_eq!(sql.last(), Some(&"COMMIT"));
        }
    }
}

#[tokio::test]
async fn dispatch_writes_preserve_atomicity_and_replay_in_postgres() -> eyre::Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let table = "message";
    for count in [2, 3_251] {
        db.0.execute_unprepared(&format!("TRUNCATE {table}"))
            .await?;
        let rows = messages(count);
        assert_eq!(store(&db, &rows[..1]).await?, 1);
        // Keep an existing conflict row to prove failed batches roll back updates too.
        db.0.execute_unprepared(&format!(
            "UPDATE {table} SET msg_body = decode('09', 'hex')"
        ))
        .await?;
        // A repeated conflict key must still reject the entire one-statement batch.
        assert!(store(&db, &[rows[0].clone(), rows[0].clone()])
            .await
            .is_err());
        db.0.execute_unprepared(&format!(
            "ALTER TABLE {table} ADD CONSTRAINT reject_dispatch_tail CHECK (nonce <> {})",
            count - 1
        ))
        .await?;
        assert!(store(&db, &rows).await.is_err());
        let stored = db.0.query_one(sea_orm::Statement::from_string(DatabaseBackend::Postgres, format!("SELECT COUNT(*) AS row_count, MIN(encode(msg_body, 'hex')) AS body FROM {table}"))).await?.unwrap();
        assert_eq!(stored.try_get::<i64>("", "row_count")?, 1);
        assert_eq!(stored.try_get::<String>("", "body")?, "09");
        db.0.execute_unprepared(&format!(
            "ALTER TABLE {table} DROP CONSTRAINT reject_dispatch_tail"
        ))
        .await?;
        assert_eq!(store(&db, &rows).await?, u64::from(count - 1));
        assert_eq!(store(&db, &rows).await?, 0);
        let stored = db.0.query_one(sea_orm::Statement::from_string(DatabaseBackend::Postgres, format!("SELECT COUNT(*) AS row_count, COUNT(*) FILTER (WHERE msg_body = decode('01', 'hex')) AS expected_bodies FROM {table}"))).await?.unwrap();
        assert_eq!(stored.try_get::<i64>("", "row_count")?, i64::from(count));
        assert_eq!(
            stored.try_get::<i64>("", "expected_bodies")?,
            i64::from(count)
        );
    }
    // Replaying without enrichment must retain the previously resolved transaction.
    let txn_id = super::write_batches::seed_transaction(&db, 0).await?;
    let rows = messages(1);
    assert_eq!(
        db.store_dispatched_messages(
            1,
            &H256::zero(),
            [StorableMessage {
                msg: rows[0].clone(),
                txn_id: Some(txn_id),
                id_override: None
            }]
            .into_iter(),
        )
        .await?,
        0
    );
    assert_eq!(store(&db, &rows).await?, 0);
    let stored =
        db.0.query_one(sea_orm::Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT origin_tx_id FROM message WHERE nonce=0".to_owned(),
        ))
        .await?
        .unwrap();
    assert_eq!(
        stored.try_get::<Option<i64>>("", "origin_tx_id")?,
        Some(txn_id)
    );
    Ok(())
}
