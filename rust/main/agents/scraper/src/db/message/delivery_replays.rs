//! Delivery replay writes must preserve enrichment without rewriting unchanged rows.
use std::time::{Duration, Instant};

use hyperlane_core::{LogMeta, H256};
use migration::MigratorTrait;
use sea_orm::{
    sqlx::postgres::PgListener, ConnectionTrait, Database, DatabaseBackend, QueryTrait, Statement,
};
use testcontainers::{runners::AsyncRunner, ImageExt};
use testcontainers_modules::postgres::Postgres;

use super::{delivered_message, delivery_insert_query, ScraperDb, StorableDelivery};
use crate::db::write_batches::seed_transaction;

fn delivery(txn_id: Option<i64>, meta: &LogMeta) -> StorableDelivery<'_> {
    StorableDelivery {
        message_id: H256::from_low_u64_be(100),
        sequence: Some(3),
        meta,
        txn_id,
    }
}

async fn row_state(db: &ScraperDb) -> eyre::Result<(String, Option<i64>)> {
    let row =
        db.0.query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT xmin::text AS version, destination_tx_id FROM delivered_message".to_owned(),
        ))
        .await?
        .expect("delivery should exist");
    Ok((
        row.try_get("", "version")?,
        row.try_get("", "destination_tx_id")?,
    ))
}

#[tokio::test]
async fn unchanged_delivery_replays_preserve_row_and_notifications() -> eyre::Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
    let db = ScraperDb::with_connection(Database::connect(&url).await?);
    migration::Migrator::up(&db.0, None).await?;
    let first_tx = seed_transaction(&db, 0).await?;
    let second_tx = seed_transaction(&db, 1).await?;
    let mut listener = PgListener::connect(&url).await?;
    listener.listen("scraper_explorer_event").await?;
    let meta = LogMeta::default();

    let mut previous_state = None;
    for (tx_id, expect_insert, expect_update) in [
        (None, true, false),
        (None, false, false),
        (Some(first_tx), false, true),
        (Some(first_tx), false, false),
        (None, false, false),
        (Some(second_tx), false, true),
        (None, false, false),
    ] {
        assert_eq!(
            db.store_deliveries(1, H256::zero(), [delivery(tx_id, &meta)].into_iter())
                .await?,
            u64::from(expect_insert)
        );
        let state = row_state(&db).await?;
        if let Some(previous) = previous_state {
            if expect_update {
                assert_ne!(state, previous);
                assert_eq!(state.1, tx_id);
            } else {
                assert_eq!(state, previous, "unchanged replay rewrote the heap tuple");
            }
        }
        let notification = tokio::time::timeout(Duration::from_millis(100), listener.recv()).await;
        if expect_insert || expect_update {
            let notification = notification??;
            let payload: serde_json::Value = serde_json::from_str(notification.payload())?;
            assert_eq!(payload["messageId"], format!("{:064x}", 100));
        } else {
            assert!(
                notification.is_err(),
                "unchanged replay emitted a notification"
            );
        }
        previous_state = Some(state);
    }

    // Near-head metadata and confirmation are owned by the frontier writer.
    // Enriching a provisional delivery must not expose it or lose its header.
    db.0.execute_unprepared("INSERT INTO scraper_head(domain,start_height,indexed_height,indexed_hash,head_height,confirmed_height,mailbox,merkle_tree_hook,interchain_gas_paymaster) VALUES(1,0,10,decode(repeat('01',32),'hex'),10,0,decode(repeat('01',20),'hex'),decode(repeat('02',20),'hex'),decode(repeat('03',20),'hex')); UPDATE delivered_message SET block_hash=decode('01','hex'), block_number=10, transaction_hash=decode('02','hex'), transaction_index=2, log_index=3").await?;
    let metadata_query = Statement::from_string(
        DatabaseBackend::Postgres,
        "SELECT (to_jsonb(d) - 'destination_tx_id')::text AS metadata FROM delivered_message d"
            .to_owned(),
    );
    let before =
        db.0.query_one(metadata_query.clone())
            .await?
            .expect("delivery exists")
            .try_get::<String>("", "metadata")?;
    db.store_deliveries(
        1,
        H256::zero(),
        [delivery(Some(first_tx), &meta)].into_iter(),
    )
    .await?;
    let after =
        db.0.query_one(metadata_query)
            .await?
            .expect("delivery exists")
            .try_get::<String>("", "metadata")?;
    assert_eq!(before, after);
    assert_eq!(row_state(&db).await?.1, Some(first_tx));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.recv())
            .await
            .is_err()
    );
    db.0.execute_unprepared("UPDATE scraper_head SET confirmed_height=10")
        .await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.recv())
            .await
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn fallback_delivery_replay_waits_for_concurrent_enrichment() -> eyre::Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
    let db = ScraperDb::with_connection(Database::connect(&url).await?);
    migration::Migrator::up(&db.0, None).await?;
    let txn_id = seed_transaction(&db, 0).await?;
    db.store_deliveries(
        1,
        H256::zero(),
        [delivery(None, &LogMeta::default())].into_iter(),
    )
    .await?;
    use sea_orm::TransactionTrait;
    let tx = db.0.begin().await?;
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE delivered_message SET destination_tx_id=$1",
        [txn_id.into()],
    ))
    .await?;
    let worker_db = ScraperDb::with_connection(Database::connect(&url).await?);
    let mut replay = tokio::spawn(async move {
        worker_db
            .store_deliveries(
                1,
                H256::zero(),
                [delivery(None, &LogMeta::default())].into_iter(),
            )
            .await
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut replay)
            .await
            .is_err()
    );
    let enriched = tx
        .query_one(Statement::from_string(
            DatabaseBackend::Postgres,
            "SELECT xmin::text AS version, destination_tx_id FROM delivered_message".to_owned(),
        ))
        .await?
        .expect("enriched delivery should exist");
    let enriched = (
        enriched.try_get::<String>("", "version")?,
        enriched.try_get::<Option<i64>>("", "destination_tx_id")?,
    );
    tx.commit().await?;
    assert_eq!(replay.await??, 0);
    assert_eq!(row_state(&db).await?, enriched);
    assert_eq!(enriched.1, Some(txn_id));
    Ok(())
}

/// PostgreSQL 16, real production migrations/triggers, ten warmed alternating
/// samples per condition. Run with `--ignored --nocapture`.
#[ignore]
#[tokio::test]
async fn benchmark_delivery_replay_writes() -> eyre::Result<()> {
    use sea_orm::ActiveValue::{NotSet, Set, Unchanged};
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let db = ScraperDb::with_connection(
        Database::connect(format!(
            "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
        ))
        .await?,
    );
    migration::Migrator::up(&db.0, None).await?;
    let txn_id = seed_transaction(&db, 0).await?;
    db.0.execute_unprepared("ALTER TABLE delivered_message SET (autovacuum_enabled=false)")
        .await?;
    for count in [1u64, 1_000] {
        db.0.execute_unprepared("TRUNCATE delivered_message")
            .await?;
        let models = (0..count)
            .map(|id| delivered_message::ActiveModel {
                id: NotSet,
                time_created: Set(crate::date_time::now()),
                msg_id: Unchanged(hyperlane_core::h256_to_bytes(&H256::from_low_u64_be(id))),
                domain: Unchanged(1),
                destination_mailbox: Unchanged(vec![0; 20]),
                destination_tx_id: Set(Some(txn_id)),
                sequence: Set(Some(id as i64)),
            })
            .collect();
        let new = delivery_insert_query(models).build(DatabaseBackend::Postgres);
        let mut old = new.clone();
        let predicate = old
            .sql
            .rfind(" WHERE ")
            .expect("new statement should filter unchanged rows");
        old.sql.truncate(predicate);
        db.0.execute(new.clone()).await?;
        for changed in [false, true] {
            let mut timings = [Vec::new(), Vec::new()];
            let mut wal = [Vec::new(), Vec::new()];
            for iteration in 0..24 {
                let variant = (iteration % 2) ^ ((iteration / 2) % 2);
                // Restore the same table state before each sample so one
                // variant cannot inherit the other's accumulated dead tuples.
                db.0.execute_unprepared("TRUNCATE delivered_message")
                    .await?;
                db.0.execute(new.clone()).await?;
                if changed {
                    db.0.execute_unprepared("UPDATE delivered_message SET destination_tx_id=NULL")
                        .await?;
                }
                let before =
                    db.0.query_one(Statement::from_string(
                        DatabaseBackend::Postgres,
                        "SELECT pg_current_wal_insert_lsn()::text AS lsn".to_owned(),
                    ))
                    .await?
                    .expect("WAL position query returns one row")
                    .try_get::<String>("", "lsn")?;
                let start = Instant::now();
                let result =
                    db.0.execute(if variant == 0 {
                        old.clone()
                    } else {
                        new.clone()
                    })
                    .await?;
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(
                    result.rows_affected(),
                    if changed || variant == 0 { count } else { 0 }
                );
                let bytes = db.0.query_one(Statement::from_sql_and_values(DatabaseBackend::Postgres,
                "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint AS bytes", [before.into()]))
                .await?.expect("WAL difference query returns one row").try_get::<i64>("", "bytes")?;
                if iteration >= 4 {
                    timings[variant].push(elapsed);
                    wal[variant].push(bytes);
                }
            }
            for variant in 0..2 {
                timings[variant].sort_by(f64::total_cmp);
                wal[variant].sort();
                println!("count={count} changed={changed} variant={variant} median_ms={:.3} median_wal_bytes={} samples_ms={:?}", (timings[variant][4] + timings[variant][5]) / 2.0, (wal[variant][4] + wal[variant][5]) / 2, timings[variant]);
            }
        }
    }
    Ok(())
}
