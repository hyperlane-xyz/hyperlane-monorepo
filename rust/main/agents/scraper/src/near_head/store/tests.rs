#![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]

use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use ethers::types::H160;
use hyperlane_core::HyperlaneMessage;
use migration::MigratorTrait;
use sea_orm::Database;
use testcontainers::{runners::AsyncRunner, ImageExt};
use testcontainers_modules::postgres::Postgres;

use super::*;

const LEASE: Duration = Duration::from_secs(60);

fn header(height: u64) -> Header {
    Header {
        height,
        hash: H256::from_low_u64_be(height + 1),
        parent: H256::from_low_u64_be(height),
        timestamp: 1,
    }
}

fn event(height: u64, index: u64, address: hyperlane_core::H256, data: EventData) -> Event {
    Event {
        block_number: height,
        block_hash: header(height).hash,
        tx_hash: Some(H256::from_low_u64_be(height * 10_000 + index).into()),
        tx_index: index,
        log_index: index,
        address,
        sequence: None,
        data,
    }
}

fn payments(height: u64, count: u64, address: hyperlane_core::H256) -> Vec<Event> {
    (0..count)
        .map(|index| {
            event(
                height,
                index,
                address,
                EventData::Gas {
                    message_id: H256::from_low_u64_be(index).into(),
                    destination: 2,
                    gas: "1".into(),
                    payment: "1".into(),
                },
            )
        })
        .collect()
}

#[tokio::test]
async fn unavailable_transaction_hashes_are_not_enrichment_work() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let db = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    ))
    .await?;
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    let contracts = Contracts {
        mailbox: H160::repeat_byte(1).into(),
        hook: H160::repeat_byte(2).into(),
        paymaster: H160::repeat_byte(3).into(),
    };
    store.initialize(&header(0), &contracts).await?;
    let initial = store.state().await?.unwrap();
    store.observe(&initial, &header(0), &header(1)).await?;
    let mut payment = payments(1, 1, contracts.paymaster).remove(0);
    payment.tx_hash = None;
    store
        .append(
            &store.state().await?.unwrap(),
            &[(header(1), vec![payment])],
            None,
        )
        .await?;
    store
        .confirm(&store.state().await?.unwrap(), &header(1), LEASE)
        .await?;

    assert!(store.unenriched("gas_payment", 0).await?.is_empty());
    let row = store
        .db
        .query_one(sql(
            "SELECT transaction_hash IS NULL AS missing FROM gas_payment",
            vec![],
        ))
        .await?
        .expect("payment row");
    assert!(row.try_get::<bool>("", "missing")?);
    Ok(())
}

#[tokio::test]
async fn confirmation_budget_preserves_blocks_and_measures_gas_dense_publication() -> Result<()> {
    let postgres = Postgres::default().with_tag("16-alpine").start().await?;
    let url = format!(
        "postgresql://postgres:postgres@127.0.0.1:{}/postgres",
        postgres.get_host_port_ipv4(5432).await?
    );
    let db = Database::connect(&url).await?;
    migration::Migrator::up(&db, None).await?;
    let store = Store { db, domain: 1 };
    let contracts = Contracts {
        mailbox: H160::repeat_byte(1).into(),
        hook: H160::repeat_byte(2).into(),
        paymaster: H160::repeat_byte(3).into(),
    };
    store.initialize(&header(0), &contracts).await?;
    let initial = store.state().await?.unwrap();
    store.observe(&initial, &header(0), &header(10_000)).await?;
    let state = store.state().await?.unwrap();
    let message = HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: 1,
        sender: hyperlane_core::H256::repeat_byte(1),
        destination: 2,
        recipient: hyperlane_core::H256::repeat_byte(2),
        body: vec![],
    };
    let message_id = message.id();
    let mixed = vec![
        event(20, 0, contracts.mailbox, EventData::Dispatch(message)),
        event(20, 1, contracts.mailbox, EventData::Delivery(message_id)),
        event(
            20,
            2,
            contracts.hook,
            EventData::Insertion {
                index: 0,
                message_id,
            },
        ),
    ];
    store
        .append(
            &state,
            &[
                (header(10), payments(10, 1001, contracts.paymaster)),
                (header(20), mixed),
                (header(30), payments(30, 1001, contracts.paymaster)),
                (header(40), payments(40, 1000, contracts.paymaster)),
                (header(10_000), vec![]),
            ],
            None,
        )
        .await?;

    // A large first block progresses intact; a later overflowing block waits.
    assert_eq!(store.confirmation_boundary(0, 10_000).await?, 10);
    assert_eq!(store.confirmation_boundary(10, 10_000).await?, 29);
    assert_eq!(store.confirmation_boundary(29, 10_000).await?, 30);
    // Exactly the budget and completely empty spans need no block-count slicing.
    assert_eq!(store.confirmation_boundary(30, 10_000).await?, 10_000);
    assert_eq!(store.confirmation_boundary(40, 10_000).await?, 10_000);
    assert_eq!(store.confirmation_boundary(0, 9).await?, 9);
    assert!(store.confirmation_boundary(10, 9).await.is_err());

    let probe = Database::connect(&url).await?;
    for (through, expected) in [
        (10, [0, 0, 1001, 0]),
        (29, [1, 1, 0, 1]),
        (30, [0, 0, 1001, 0]),
        (10_000, [0, 0, 1000, 0]),
    ] {
        let state = store.state().await?.unwrap();
        assert_eq!(
            store.confirmation_boundary(state.confirmed, 10_000).await?,
            through
        );
        let wal_before = store
            .db
            .query_one(sql(
                "SELECT pg_current_wal_insert_lsn()::text AS lsn",
                vec![],
            ))
            .await?
            .unwrap()
            .try_get::<String>("", "lsn")?;
        let done = AtomicBool::new(false);
        let (publication, lock_probe) = tokio::join!(
            async {
                let start = Instant::now();
                let result = store.confirm(&state, &header(through), LEASE).await;
                done.store(true, Ordering::Relaxed);
                (result, start.elapsed())
            },
            async {
                let mut longest = Duration::ZERO;
                while !done.load(Ordering::Relaxed) {
                    let tx = probe.begin().await?;
                    let start = Instant::now();
                    tx.query_one(sql(
                        "SELECT domain FROM scraper_head WHERE domain=1 FOR UPDATE",
                        vec![],
                    ))
                    .await?;
                    longest = longest.max(start.elapsed());
                    tx.rollback().await?;
                }
                Ok::<_, eyre::Report>(longest)
            },
        );
        assert_eq!(publication.0?, expected);
        let wal_bytes = store
            .db
            .query_one(sql(
                "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1::pg_lsn)::text AS bytes",
                vec![wal_before.into()],
            ))
            .await?
            .unwrap()
            .try_get::<String>("", "bytes")?;
        eprintln!(
            "confirmation through {through}: {:?}, max progress-lock acquisition (including round trip) {:?}, cluster WAL delta {wal_bytes} bytes; local fixture only",
            publication.1,
            lock_probe?
        );
        assert_eq!(store.state().await?.unwrap().confirmed, through);
    }
    // All gas rows acquire one cursor exactly once, after their block is published.
    let ranges = store
        .db
        .query_all(sql(
            "SELECT g.block_number,min(c.stream_cursor) AS first,max(c.stream_cursor) AS last,count(*) AS count FROM gas_payment g JOIN gas_payment_stream_cursor c ON c.gas_payment_id=g.id GROUP BY g.block_number ORDER BY g.block_number",
            vec![],
        ))
        .await?;
    let ranges = ranges
        .iter()
        .map(|row| {
            Ok((
                row.try_get::<i64>("", "block_number")?,
                row.try_get::<i64>("", "first")?,
                row.try_get::<i64>("", "last")?,
                row.try_get::<i64>("", "count")?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    assert_eq!(
        ranges,
        vec![
            (10, 1, 1001, 1001),
            (30, 1002, 2002, 1001),
            (40, 2003, 3002, 1000)
        ]
    );
    let state = store.state().await?.unwrap();
    assert_eq!(store.confirm(&state, &header(10_000), LEASE).await?, [0; 4]);
    Ok(())
}
