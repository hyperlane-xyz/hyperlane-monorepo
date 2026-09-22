use std::time::{Duration, Instant};

use eyre::Result;
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    TransactionTrait,
};
use testcontainers::{runners::AsyncRunner, ContainerAsync, ImageExt};
use testcontainers_modules::postgres::Postgres;
use tokio::time::{sleep, timeout};

use super::*;
use crate::Migrator;

async fn database(
    steps: Option<u32>,
) -> Result<(ContainerAsync<Postgres>, DatabaseConnection, String)> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    Migrator::up(&db, steps).await?;
    Ok((postgres, db, url))
}

fn payments(first: u32, count: u32, confirmed: bool) -> String {
    format!(
        "INSERT INTO gas_payment (domain,origin,destination,msg_id,payment,gas_amount,tx_id,log_index,interchain_gas_paymaster,confirmed) \
         SELECT 1,1,1,decode(lpad(to_hex(n),64,'0'),'hex'),1,1,NULL,n,decode(repeat('11',20),'hex'),{confirmed} \
         FROM generate_series({first},{} ) n",
        first + count - 1
    )
}

async fn scalar(db: &impl ConnectionTrait, query: &str) -> Result<i64> {
    Ok(db
        .query_one(Statement::from_string(
            DbBackend::Postgres,
            query.to_owned(),
        ))
        .await?
        .expect("scalar row")
        .try_get("", "value")?)
}

async fn migration(db: &DatabaseConnection, batch: bool) -> Result<()> {
    let tx = db.begin().await?;
    let manager = SchemaManager::new(&tx);
    if batch {
        Migration.up(&manager).await?;
    } else {
        Migration.down(&manager).await?;
    }
    tx.commit().await?;
    Ok(())
}

#[tokio::test]
async fn legacy_boundary_survives_upgrade_enrichment_confirmation_and_downgrade() -> Result<()> {
    let cursor_position = Migrator::migrations()
        .iter()
        .position(|m| {
            m.name() == crate::m20260830_000013_gas_payment_stream_cursor::Migration.name()
        })
        .expect("cursor migration");
    let (_postgres, db, _) = database(Some(cursor_position as u32)).await?;
    db.execute_unprepared(
        "INSERT INTO gas_payment (domain,origin,destination,msg_id,payment,gas_amount,tx_id,log_index,interchain_gas_paymaster) \
         SELECT 1,1,1,decode(repeat('11',32),'hex'),1,1,NULL,n,decode(repeat('11',20),'hex') FROM generate_series(1,2) n",
    ).await?;
    Migrator::up(&db, None).await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT legacy_max_id AS value FROM gas_payment_stream_head"
        )
        .await?,
        2
    );

    // Updating historical rows must not allocate a new cursor for legacy IDs.
    db.execute_unprepared("UPDATE gas_payment SET payment=2")
        .await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS value FROM gas_payment_stream_cursor"
        )
        .await?,
        0
    );
    db.execute_unprepared(&payments(3, 3, false)).await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT last_cursor AS value FROM gas_payment_stream_head"
        )
        .await?,
        2
    );
    db.execute_unprepared("UPDATE gas_payment SET confirmed=true")
        .await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT last_cursor AS value FROM gas_payment_stream_head"
        )
        .await?,
        5
    );
    db.execute_unprepared("UPDATE gas_payment SET confirmed=true,payment=3")
        .await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS value FROM gas_payment_stream_cursor"
        )
        .await?,
        3
    );

    // A failed statement must roll back the head reservation and partial mapping.
    db.execute_unprepared(
        "ALTER TABLE gas_payment_stream_cursor ADD CONSTRAINT reject_tail CHECK (stream_cursor<>7)",
    )
    .await?;
    assert!(db.execute_unprepared(&payments(6, 3, true)).await.is_err());
    assert_eq!(
        scalar(
            &db,
            "SELECT last_cursor AS value FROM gas_payment_stream_head"
        )
        .await?,
        5
    );
    assert_eq!(
        scalar(&db, "SELECT count(*) AS value FROM gas_payment").await?,
        5
    );
    db.execute_unprepared("ALTER TABLE gas_payment_stream_cursor DROP CONSTRAINT reject_tail")
        .await?;
    db.execute_unprepared(&payments(6, 3, true)).await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT last_cursor AS value FROM gas_payment_stream_head"
        )
        .await?,
        8
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT min(stream_cursor) AS value FROM gas_payment_stream_cursor"
        )
        .await?,
        3
    );

    // Rolling back just this migration preserves its allocated ranges.
    Migrator::down(&db, Some(1)).await?;
    db.execute_unprepared(&payments(9, 2, true)).await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT last_cursor AS value FROM gas_payment_stream_head"
        )
        .await?,
        10
    );
    Migrator::up(&db, None).await?;
    db.execute_unprepared(&payments(11, 2, true)).await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT last_cursor AS value FROM gas_payment_stream_head"
        )
        .await?,
        12
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS value FROM gas_payment_stream_cursor"
        )
        .await?,
        10
    );
    Ok(())
}

#[tokio::test]
async fn concurrent_ranges_follow_commit_order_and_aborted_reservations_leave_no_gap() -> Result<()>
{
    let (_postgres, db, url) = database(None).await?;
    for rollback in [false, true] {
        db.execute_unprepared("TRUNCATE gas_payment CASCADE; TRUNCATE gas_payment_stream_head")
            .await?;
        let first = db.begin().await?;
        first.execute_unprepared(&payments(1, 3, true)).await?;
        // Exercise several allocator invocations under the same transaction lock.
        first.execute_unprepared(&payments(4, 2, true)).await?;
        let mut options = ConnectOptions::new(url.clone());
        options.max_connections(1).min_connections(1);
        let second = Database::connect(options).await?;
        let pid = scalar(&second, "SELECT pg_backend_pid()::bigint AS value").await?;
        let waiting =
            tokio::spawn(async move { second.execute_unprepared(&payments(10, 4, true)).await });
        // Observe an actual database lock wait, rather than depending on scheduling.
        timeout(Duration::from_secs(10), async {
            loop {
                if scalar(&db, &format!("SELECT count(*) AS value FROM pg_stat_activity WHERE pid={pid} AND wait_event_type='Lock'")).await? == 1 {
                    return Ok::<_, eyre::Report>(());
                }
                sleep(Duration::from_millis(10)).await;
            }
        }).await??;
        assert!(!waiting.is_finished());
        if rollback {
            first.rollback().await?;
        } else {
            first.commit().await?;
        }
        timeout(Duration::from_secs(10), waiting).await???;
        let expected = if rollback { 4 } else { 9 };
        assert_eq!(
            scalar(
                &db,
                "SELECT last_cursor AS value FROM gas_payment_stream_head"
            )
            .await?,
            expected
        );
        assert_eq!(
            scalar(
                &db,
                "SELECT count(*) AS value FROM gas_payment_stream_cursor"
            )
            .await?,
            expected
        );
        assert_eq!(scalar(&db, "SELECT min(c.stream_cursor) AS value FROM gas_payment_stream_cursor c JOIN gas_payment p ON p.id=c.gas_payment_id WHERE p.log_index>=10").await?, if rollback { 1 } else { 6 });
    }
    // Physical IDs can be allocated before a different transaction commits.
    // Cursor order must follow allocation under the head lock, not row ID order.
    db.execute_unprepared("TRUNCATE gas_payment CASCADE; TRUNCATE gas_payment_stream_head")
        .await?;
    let delayed = db.begin().await?;
    let reserved = scalar(&delayed, "SELECT nextval('gas_payment_id_seq') AS value").await?;
    db.execute_unprepared(&payments(10, 1, true)).await?;
    delayed.execute_unprepared(&format!(
        "INSERT INTO gas_payment (id,domain,origin,destination,msg_id,payment,gas_amount,tx_id,log_index,interchain_gas_paymaster) \
         VALUES ({reserved},1,1,1,decode(repeat('11',32),'hex'),1,1,NULL,0,decode(repeat('11',20),'hex'))"
    )).await?;
    delayed.commit().await?;
    assert_eq!(scalar(&db, &format!("SELECT stream_cursor AS value FROM gas_payment_stream_cursor WHERE gas_payment_id={reserved}")).await?, 2);
    Ok(())
}

#[tokio::test]
async fn mixed_stream_upserts_allocate_only_newly_confirmed_rows() -> Result<()> {
    let (_postgres, db, _) = database(None).await?;
    // The existing resolved-row identity contains tx_id; use the near-head block
    // identity to exercise a real upsert without creating unrelated receipt rows.
    db.execute_unprepared(
        "INSERT INTO gas_payment (domain,origin,destination,msg_id,payment,gas_amount,tx_id,log_index,interchain_gas_paymaster,block_hash,confirmed) \
         SELECT 1,1,1,decode(repeat('11',32),'hex'),1,1,NULL,n,decode(repeat(CASE WHEN n%2=0 THEN '22' ELSE '11' END,20),'hex'),decode(repeat('22',32),'hex'),n<=2 \
         FROM generate_series(1,4) n ORDER BY n DESC",
    ).await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS value FROM gas_payment_stream_cursor"
        )
        .await?,
        2
    );
    let upsert = "INSERT INTO gas_payment (domain,origin,destination,msg_id,payment,gas_amount,tx_id,log_index,interchain_gas_paymaster,block_hash,confirmed) \
         SELECT 1,1,1,decode(repeat('11',32),'hex'),2,1,NULL,n,decode(repeat(CASE WHEN n%2=0 THEN '22' ELSE '11' END,20),'hex'),decode(repeat('22',32),'hex'),true \
         FROM generate_series(1,6) n \
         ON CONFLICT (domain,block_hash,log_index) WHERE block_hash IS NOT NULL DO UPDATE SET confirmed=true,payment=EXCLUDED.payment";
    db.execute_unprepared(upsert).await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS value FROM gas_payment_stream_cursor"
        )
        .await?,
        6
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS value FROM gas_payment_stream_head WHERE last_cursor=3"
        )
        .await?,
        2
    );
    db.execute_unprepared("UPDATE gas_payment SET confirmed=true WHERE false")
        .await?;
    db.execute_unprepared("UPDATE gas_payment SET payment=4")
        .await?;
    // INSERT's transition table must exclude rows handled by DO UPDATE. Replay
    // mapped rows without mentioning confirmed in the assignment as enrichment does.
    db.execute_unprepared(&upsert.replace("SET confirmed=true,payment", "SET payment"))
        .await?;
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS value FROM gas_payment_stream_cursor"
        )
        .await?,
        6
    );
    assert_eq!(scalar(&db, "SELECT count(*) AS value FROM gas_payment_stream_cursor c JOIN gas_payment p ON p.id=c.gas_payment_id WHERE c.domain<>p.domain OR c.interchain_gas_paymaster<>p.interchain_gas_paymaster").await?, 0);
    Ok(())
}

#[tokio::test]
async fn notifications_observe_committed_cursor_mappings_and_exclude_rollbacks() -> Result<()> {
    let (_postgres, db, url) = database(None).await?;
    let mut listener = sea_orm::sqlx::postgres::PgListener::connect(&url).await?;
    listener.listen("scraper_event").await?;
    let tx = db.begin().await?;
    tx.execute_unprepared(&payments(1, 3, true)).await?;
    assert!(timeout(Duration::from_millis(50), listener.recv())
        .await
        .is_err());
    tx.commit().await?;
    for _ in 0..3 {
        let notification = timeout(Duration::from_secs(5), listener.recv()).await??;
        let row = db.query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT count(*) AS value FROM gas_payment_stream_cursor WHERE gas_payment_id=($1::jsonb->>'id')::bigint",
            [notification.payload().into()],
        )).await?.expect("notification mapping query");
        assert_eq!(row.try_get::<i64>("", "value")?, 1);
    }
    let tx = db.begin().await?;
    tx.execute_unprepared(&payments(4, 3, true)).await?;
    tx.rollback().await?;
    assert!(timeout(Duration::from_millis(50), listener.recv())
        .await
        .is_err());
    assert_eq!(
        scalar(
            &db,
            "SELECT last_cursor AS value FROM gas_payment_stream_head"
        )
        .await?,
        3
    );
    Ok(())
}

#[tokio::test]
async fn concurrent_multi_stream_batches_lock_heads_in_the_same_order() -> Result<()> {
    let (_postgres, db, _) = database(None).await?;
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(8));
    let mut tasks = Vec::new();
    for writer in 0..8 {
        let db = db.clone();
        let barrier = barrier.clone();
        tasks.push(tokio::spawn(async move {
            let order = if writer % 2 == 0 { "ASC" } else { "DESC" };
            // Each writer presents the two stream heads in the opposite order to
            // its neighbor. Allocation must sort them before acquiring row locks.
            let query = format!(
                "INSERT INTO gas_payment (domain,origin,destination,msg_id,payment,gas_amount,tx_id,log_index,interchain_gas_paymaster) \
                 SELECT 1,1,1,decode(repeat('11',32),'hex'),1,1,NULL,n,decode(repeat(CASE WHEN n<=50 THEN '11' ELSE '22' END,20),'hex') \
                 FROM generate_series(1,100) n ORDER BY n {order}"
            );
            barrier.wait().await;
            db.execute_unprepared(&query).await
        }));
    }
    for task in tasks {
        timeout(Duration::from_secs(10), task).await???;
    }
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS value FROM gas_payment_stream_head WHERE last_cursor=400"
        )
        .await?,
        2
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT count(*) AS value FROM gas_payment_stream_cursor"
        )
        .await?,
        800
    );
    assert_eq!(
        scalar(
            &db,
            "SELECT min(stream_cursor) AS value FROM gas_payment_stream_cursor"
        )
        .await?,
        1
    );
    Ok(())
}

/// Reproducible local comparison, including the unchanged row notification triggers.
#[tokio::test]
#[ignore = "local PostgreSQL publication benchmark; run with --ignored --nocapture"]
async fn benchmark_confirmation_cursor_allocation() -> Result<()> {
    let (_postgres, db, _) = database(None).await?;
    // Alternate implementations on one database to avoid measuring different hosts.
    // Each sample starts with a warm head and a warmed trigger query. Iteration zero
    // is a warmup; report medians from the remaining ten samples per implementation.
    let mut installed_batch = true;
    let sizes =
        std::env::var("SCRAPER_CURSOR_BENCHMARK_ROWS").unwrap_or_else(|_| "1,10,1000".to_owned());
    for rows in sizes.split(',').map(str::parse::<u32>) {
        let rows = rows?;
        eyre::ensure!(rows > 0, "Benchmark batch must be nonempty");
        for operation in ["insert", "confirm", "enrich", "provisional"] {
            for iteration in 0..11 {
                let order = if iteration % 2 == 0 {
                    [false, true]
                } else {
                    [true, false]
                };
                for batch in order {
                    if installed_batch != batch {
                        migration(&db, batch).await?;
                        installed_batch = batch;
                    }
                    db.execute_unprepared(
                        "TRUNCATE gas_payment CASCADE; TRUNCATE gas_payment_stream_head",
                    )
                    .await?;
                    // Keep a warm head, as steady-state publication normally does.
                    db.execute_unprepared(&payments(0, 1, operation != "confirm"))
                        .await?;
                    if operation == "confirm" {
                        db.execute_unprepared(
                            "UPDATE gas_payment SET confirmed=true WHERE log_index=0",
                        )
                        .await?;
                    } else if operation == "enrich" {
                        db.execute_unprepared("UPDATE gas_payment SET payment=2 WHERE log_index=0")
                            .await?;
                    }
                    if matches!(operation, "confirm" | "enrich") {
                        db.execute_unprepared(&payments(1, rows, operation == "enrich"))
                            .await?;
                    }
                    let before = db
                        .query_one(Statement::from_string(
                            DbBackend::Postgres,
                            "SELECT pg_current_wal_insert_lsn()::text AS lsn".to_owned(),
                        ))
                        .await?
                        .expect("WAL row")
                        .try_get::<String>("", "lsn")?;
                    let query = match operation {
                        "insert" => payments(1, rows, true),
                        "provisional" => payments(1, rows, false),
                        "confirm" => {
                            "UPDATE gas_payment SET confirmed=true WHERE NOT confirmed".to_owned()
                        }
                        _ => "UPDATE gas_payment SET payment=2 WHERE log_index>0".to_owned(),
                    };
                    let start = Instant::now();
                    db.execute_unprepared(&query).await?;
                    let elapsed = start.elapsed();
                    let wal = scalar(&db, &format!("SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'{before}'::pg_lsn)::bigint AS value")).await?;
                    let expected = if operation == "provisional" {
                        1
                    } else {
                        i64::from(rows) + 1
                    };
                    assert_eq!(
                        scalar(
                            &db,
                            "SELECT last_cursor AS value FROM gas_payment_stream_head"
                        )
                        .await?,
                        expected
                    );
                    assert_eq!(
                        scalar(
                            &db,
                            "SELECT count(*) AS value FROM gas_payment_stream_cursor"
                        )
                        .await?,
                        expected
                    );
                    println!("cursor_allocator batch={batch} operation={operation} iteration={iteration} rows={rows} elapsed_us={} wal_bytes={wal}", elapsed.as_micros());
                }
            }
        }
    }
    Ok(())
}
