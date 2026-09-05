//! Single-statement atomicity and multi-chunk transaction boundaries.
use std::collections::BTreeMap;

use hyperlane_core::{HyperlaneMessage, LogMeta, H256};
use migration::MigratorTrait;
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, MockDatabase, Value};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use super::{ScraperDb, StorableMessage, StorableRawMessageDispatch};

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

async fn store(db: &ScraperDb, raw: bool, messages: &[HyperlaneMessage]) -> eyre::Result<u64> {
    let meta = LogMeta::default();
    if raw {
        db.store_raw_message_dispatches(
            1,
            &H256::zero(),
            messages
                .iter()
                .map(|msg| StorableRawMessageDispatch { msg, meta: &meta }),
        )
        .await
    } else {
        db.store_dispatched_messages(
            1,
            &H256::zero(),
            messages.iter().cloned().map(|msg| StorableMessage {
                msg,
                meta: &meta,
                txn_id: None,
                id_override: None,
            }),
        )
        .await
    }
}

#[tokio::test]
async fn dispatch_statement_counts_preserve_multi_chunk_transactions() {
    for raw in [false, true] {
        let bound = if raw { 2_954 } else { 3_250 };
        for count in [0, 1, bound, bound + 1] {
            let chunks = if count <= bound { 1 } else { 2 };
            let row = |name: &str, value: i64| {
                vec![BTreeMap::from([(
                    name.to_owned(),
                    Value::BigInt(Some(value)),
                )])]
            };
            let mut results = vec![row("max_id", 0)];
            results.extend((0..chunks).map(|_| row("id", 1)));
            results.push(row("num_items", i64::from(count)));
            let db = ScraperDb::with_connection(
                MockDatabase::new(DatabaseBackend::Postgres)
                    .append_query_results(results)
                    .into_connection(),
            );
            assert_eq!(
                store(&db, raw, &messages(count)).await.unwrap(),
                u64::from(count)
            );
            let log = db.0.into_transaction_log();
            let sql: Vec<_> = log
                .iter()
                .flat_map(|transaction| transaction.statements())
                .map(|statement| statement.sql.as_str())
                .collect();
            if count == 0 {
                assert!(sql.is_empty());
            } else if count <= bound {
                assert_eq!(sql.len(), 3);
                assert!(sql[0].starts_with("SELECT MAX("));
                assert!(sql[1].starts_with("INSERT"));
                assert!(sql[2].starts_with("SELECT COUNT("));
            } else {
                assert_eq!(sql.len(), 6);
                assert_eq!(sql[1], "BEGIN");
                assert!(sql[2].starts_with("INSERT"));
                assert!(sql[3].starts_with("INSERT"));
                assert_eq!(sql[4], "COMMIT");
            }
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
    for raw in [false, true] {
        let (table, bound) = if raw {
            ("raw_message_dispatch", 2_954)
        } else {
            ("message", 3_250)
        };
        for count in [2, bound + 1] {
            db.0.execute_unprepared(&format!("TRUNCATE {table}"))
                .await?;
            let rows = messages(count);
            assert_eq!(store(&db, raw, &rows[..1]).await?, 1);
            // Keep an existing conflict row to prove failed batches roll back updates too.
            db.0.execute_unprepared(&format!(
                "UPDATE {table} SET msg_body = decode('09', 'hex')"
            ))
            .await?;
            // A repeated conflict key must still reject the entire one-statement batch.
            assert!(store(&db, raw, &[rows[0].clone(), rows[0].clone()])
                .await
                .is_err());
            db.0.execute_unprepared(&format!(
                "ALTER TABLE {table} ADD CONSTRAINT reject_dispatch_tail CHECK (nonce <> {})",
                count - 1
            ))
            .await?;
            assert!(store(&db, raw, &rows).await.is_err());
            let stored = db.0.query_one(sea_orm::Statement::from_string(DatabaseBackend::Postgres, format!("SELECT COUNT(*) AS row_count, MIN(encode(msg_body, 'hex')) AS body FROM {table}"))).await?.unwrap();
            assert_eq!(stored.try_get::<i64>("", "row_count")?, 1);
            assert_eq!(stored.try_get::<String>("", "body")?, "09");
            db.0.execute_unprepared(&format!(
                "ALTER TABLE {table} DROP CONSTRAINT reject_dispatch_tail"
            ))
            .await?;
            assert_eq!(store(&db, raw, &rows).await?, u64::from(count - 1));
            assert_eq!(store(&db, raw, &rows).await?, 0);
            let stored = db.0.query_one(sea_orm::Statement::from_string(DatabaseBackend::Postgres, format!("SELECT COUNT(*) AS row_count, COUNT(*) FILTER (WHERE msg_body = decode('01', 'hex')) AS expected_bodies FROM {table}"))).await?.unwrap();
            assert_eq!(stored.try_get::<i64>("", "row_count")?, i64::from(count));
            assert_eq!(
                stored.try_get::<i64>("", "expected_bodies")?,
                i64::from(count)
            );
        }
    }
    Ok(())
}
