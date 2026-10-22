//! Regression tests for PostgreSQL statement bounds and atomic event writes.

use std::collections::BTreeMap;

use migration::MigratorTrait;
use sea_orm::{
    sqlx::postgres::PgListener, ColumnTrait, ConnectionTrait, Database, DatabaseBackend,
    EntityTrait, MockDatabase, MockExecResult, PaginatorTrait, QueryFilter, Value,
};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use hyperlane_core::{BlockInfo, TxnInfo, TxnReceiptInfo, H256, H512, U256};

use super::{generated::delivered_message, ScraperDb, StorableDelivery, StorableTxn};

const DOMAIN: u32 = 1;

fn result(key: &str, value: i64) -> Vec<BTreeMap<String, Value>> {
    vec![BTreeMap::from([(
        key.to_owned(),
        Value::BigInt(Some(value)),
    )])]
}

fn deliveries(count: u32) -> impl Iterator<Item = StorableDelivery> {
    (0..count).map(|index| StorableDelivery {
        message_id: H256::from_low_u64_be(u64::from(index)),
        sequence: Some(i64::from(index)),
        txn_id: None,
    })
}

#[tokio::test]
async fn empty_event_writes_do_not_access_database() {
    let db =
        ScraperDb::with_connection(MockDatabase::new(DatabaseBackend::Postgres).into_connection());
    assert_eq!(
        db.store_deliveries(DOMAIN, H256::zero(), std::iter::empty())
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        db.store_dispatched_messages(DOMAIN, &H256::zero(), std::iter::empty())
            .await
            .unwrap(),
        0
    );
    assert!(db.0.into_transaction_log().is_empty());
}

#[tokio::test]
async fn delivery_batches_bound_binds_and_preserve_small_fast_path() {
    for count in [1, 12_000] {
        let chunks = if count == 1 { 1 } else { 2 };
        let results = vec![result("max_id", 0), result("num_items", i64::from(count))];
        let db = ScraperDb::with_connection(
            MockDatabase::new(DatabaseBackend::Postgres)
                .append_exec_results((0..chunks).map(|_| MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }))
                .append_query_results(results)
                .into_connection(),
        );
        assert_eq!(
            db.store_deliveries(DOMAIN, H256::zero(), deliveries(count))
                .await
                .unwrap(),
            u64::from(count)
        );
        let log = db.0.into_transaction_log();
        let statements: Vec<_> = log
            .iter()
            .flat_map(|transaction| transaction.statements())
            .collect();
        let binds: Vec<_> = statements
            .iter()
            .filter(|statement| statement.sql.starts_with("INSERT"))
            .map(|statement| statement.values.as_ref().unwrap().0.len())
            .collect();
        assert_eq!(
            binds,
            if count == 1 {
                vec![6]
            } else {
                vec![60_000, 12_000]
            }
        );
        assert_eq!(statements.len(), if count == 1 { 3 } else { 6 });
        if count > 1 {
            assert_eq!(log[1].statements().first().unwrap().sql, "BEGIN");
            assert_eq!(log[1].statements().last().unwrap().sql, "COMMIT");
        }
    }
}

#[tokio::test]
async fn duplicate_keys_across_chunks_are_rejected() {
    let db = ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([result("max_id", 0)])
            .into_connection(),
    );

    let rows = deliveries(12_000).chain(deliveries(1));
    assert!(db
        .store_deliveries(DOMAIN, H256::zero(), rows)
        .await
        .unwrap_err()
        .to_string()
        .contains("Duplicate delivery"));
    let log = db.0.into_transaction_log();
    assert!(log.is_empty());
}

pub(super) async fn seed_transaction(db: &ScraperDb, index: u64) -> eyre::Result<i64> {
    let hash = H256::from_low_u64_be(55);
    db.store_blocks(
        DOMAIN,
        [BlockInfo {
            hash,
            timestamp: 1_700_000_000,
            number: 500,
        }]
        .into_iter(),
    )
    .await?;
    let block_id = db.get_block_basic([&hash].into_iter()).await?[0].id;
    let tx_hash = H512::from_low_u64_be(66 + index);
    db.store_txns(
        [StorableTxn {
            block_id,
            info: TxnInfo {
                hash: tx_hash,
                gas_limit: U256::one(),
                max_priority_fee_per_gas: None,
                max_fee_per_gas: None,
                gas_price: None,
                nonce: 0,
                sender: H256::zero(),
                recipient: None,
                receipt: Some(TxnReceiptInfo {
                    gas_used: U256::one(),
                    cumulative_gas_used: U256::one(),
                    effective_gas_price: None,
                }),
                raw_input_data: None,
            },
        }]
        .into_iter(),
    )
    .await?;
    Ok(db.get_txn_ids([&tx_hash].into_iter()).await?[&tx_hash])
}

async fn explorer_notifications(db: &ScraperDb, listener: &mut PgListener) -> eyre::Result<usize> {
    // PostgreSQL delivers notifications in commit order. A separate channel
    // provides a deterministic barrier after the writes, without a quiet-period sleep.
    db.0.execute_unprepared("SELECT pg_notify('replay_test_barrier', 'ready')")
        .await?;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut count = 0_usize;
        loop {
            let notification = listener.recv().await?;
            if notification.channel() == "replay_test_barrier" {
                return Ok(count);
            }
            assert_eq!(notification.channel(), "scraper_explorer_event");
            count = count.saturating_add(1);
        }
    })
    .await?
}

#[tokio::test]
async fn unchanged_replays_preserve_rows_and_do_not_notify_explorer() -> eyre::Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let url = format!("postgresql://postgres:postgres@127.0.0.1:{port}/postgres");
    let connection = Database::connect(&url).await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let original_tx = seed_transaction(&db, 0).await?;
    let replacement_tx = seed_transaction(&db, 1).await?;
    let mut listener = PgListener::connect(&url).await?;
    listener.listen("scraper_explorer_event").await?;
    listener.listen("replay_test_barrier").await?;

    let address = H256::from_low_u64_be(1);
    db.store_deliveries(
        DOMAIN,
        address,
        deliveries(1).map(|mut row| {
            row.txn_id = Some(original_tx);
            row
        }),
    )
    .await?;
    assert_eq!(explorer_notifications(&db, &mut listener).await?, 1);
    let delivery_before = delivered_message::Entity::find()
        .one(&db.0)
        .await?
        .expect("stored event row");

    for _ in 0..2 {
        assert_eq!(
            db.store_deliveries(
                DOMAIN,
                address,
                deliveries(1).map(|mut row| {
                    row.txn_id = Some(original_tx);
                    row
                })
            )
            .await?,
            0
        );
        // A later unresolved replay must not clear a resolved transaction.
        assert_eq!(
            db.store_deliveries(DOMAIN, address, deliveries(1)).await?,
            0
        );
        assert_eq!(explorer_notifications(&db, &mut listener).await?, 0);
        assert_eq!(
            delivered_message::Entity::find()
                .one(&db.0)
                .await?
                .expect("stored event row"),
            delivery_before
        );
    }

    db.store_deliveries(
        DOMAIN,
        address,
        deliveries(1).map(|mut row| {
            row.txn_id = Some(replacement_tx);
            row
        }),
    )
    .await?;
    assert_eq!(explorer_notifications(&db, &mut listener).await?, 1);
    assert_eq!(
        delivered_message::Entity::find()
            .one(&db.0)
            .await?
            .expect("stored event row")
            .destination_tx_id,
        Some(replacement_tx)
    );
    Ok(())
}

#[tokio::test]
async fn bulk_events_replay_and_rollback_failed_tail_in_postgres() -> eyre::Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);

    let address = H256::from_low_u64_be(1);

    assert_eq!(
        db.store_deliveries(DOMAIN, address, deliveries(12_000))
            .await?,
        12_000
    );
    // Both INSERT chunks have no changed rows on replay. This must still
    // commit successfully when the conflict predicate skips every UPDATE.
    assert_eq!(
        db.store_deliveries(DOMAIN, address, deliveries(12_000))
            .await?,
        0
    );
    assert_eq!(
        delivered_message::Entity::find().count(&db.0).await?,
        12_000
    );
    db.0.execute_unprepared("TRUNCATE delivered_message")
        .await?;
    let original_tx = seed_transaction(&db, 0).await?;
    let replacement_tx = seed_transaction(&db, 1).await?;
    db.store_deliveries(
        DOMAIN,
        address,
        deliveries(1).map(|mut row| {
            row.txn_id = Some(original_tx);
            row
        }),
    )
    .await?;
    db.0.execute_unprepared("ALTER TABLE delivered_message ADD CONSTRAINT reject_delivery_tail CHECK (sequence <> 10000)").await?;
    assert!(db
        .store_deliveries(
            DOMAIN,
            address,
            deliveries(12_000).map(|mut row| {
                row.txn_id = Some(replacement_tx);
                row
            })
        )
        .await
        .is_err());
    assert_eq!(delivered_message::Entity::find().count(&db.0).await?, 1);
    assert_eq!(
        delivered_message::Entity::find()
            .one(&db.0)
            .await?
            .unwrap()
            .destination_tx_id,
        Some(original_tx)
    );
    db.0.execute_unprepared("ALTER TABLE delivered_message DROP CONSTRAINT reject_delivery_tail")
        .await?;
    assert_eq!(
        db.store_deliveries(DOMAIN, address, deliveries(12_000))
            .await?,
        11_999
    );

    Ok(())
}

#[tokio::test]
async fn dispatch_chunks_preserve_owned_payloads_and_replay() -> eyre::Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);

    let address = H256::from_low_u64_be(1);
    let rows = || {
        (0..3_251u32).map(|nonce| super::StorableMessage {
            msg: hyperlane_core::HyperlaneMessage {
                nonce,
                origin: DOMAIN,
                destination: DOMAIN,
                body: if nonce == 0 {
                    vec![]
                } else {
                    vec![(nonce % 251) as u8; 1_024]
                },
                ..Default::default()
            },
            txn_id: None,
            id_override: None,
        })
    };
    assert_eq!(
        db.store_dispatched_messages(DOMAIN, &address, rows())
            .await?,
        3_251
    );
    assert_eq!(
        db.store_dispatched_messages(DOMAIN, &address, rows())
            .await?,
        0
    );
    let stored = super::generated::message::Entity::find().all(&db.0).await?;
    assert_eq!(stored.len(), 3_251);
    for row in stored {
        let expected = if row.nonce == 0 {
            None
        } else {
            Some(vec![(row.nonce % 251) as u8; 1_024])
        };
        assert_eq!(row.msg_body, expected);
    }
    Ok(())
}

#[tokio::test]
async fn hash_lookups_read_both_chunks_without_duplicate_results_in_postgres() -> eyre::Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let first_tx = seed_transaction(&db, 0).await?;
    let tail_tx = seed_transaction(&db, 65_000).await?;
    db.store_blocks(
        DOMAIN,
        [BlockInfo {
            hash: H256::from_low_u64_be(65_055),
            timestamp: 1_700_000_001,
            number: 501,
        }]
        .into_iter(),
    )
    .await?;
    let blocks: Vec<_> = (0..66_000).map(H256::from_low_u64_be).collect();
    let txns: Vec<_> = (0..66_000).map(H512::from_low_u64_be).collect();
    let found_blocks = db
        .get_block_basic(blocks.iter().chain(blocks[55..56].iter()))
        .await?;
    assert_eq!(found_blocks.len(), 2);
    assert!(found_blocks.iter().any(|row| row.hash == blocks[55]));
    assert!(found_blocks.iter().any(|row| row.hash == blocks[65_055]));
    let found_txns = db
        .get_txn_ids(txns.iter().chain(txns[66..67].iter()))
        .await?;
    assert_eq!(found_txns.len(), 2);
    assert_eq!(found_txns[&txns[66]], first_tx);
    assert_eq!(found_txns[&txns[65_066]], tail_tx);
    Ok(())
}

#[tokio::test]
async fn transaction_inputs_survive_storage() -> eyre::Result<()> {
    use super::generated::transaction;

    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    seed_transaction(&db, 0).await?;
    let block_id = db
        .get_block_basic([&H256::from_low_u64_be(55)].into_iter())
        .await?[0]
        .id;
    let inputs = [None, Some(vec![]), Some(vec![0xab; 4_096])];
    let transactions = || {
        inputs
            .iter()
            .enumerate()
            .map(|(index, raw_input_data)| StorableTxn {
                block_id,
                info: TxnInfo {
                    hash: H512::from_low_u64_be(100 + index as u64),
                    gas_limit: U256::one(),
                    max_priority_fee_per_gas: None,
                    max_fee_per_gas: None,
                    gas_price: None,
                    nonce: 0,
                    sender: H256::zero(),
                    recipient: None,
                    receipt: Some(TxnReceiptInfo {
                        gas_used: U256::one(),
                        cumulative_gas_used: U256::one(),
                        effective_gas_price: None,
                    }),
                    raw_input_data: raw_input_data.clone(),
                },
            })
    };
    db.store_txns(transactions()).await?;
    db.store_txns(transactions()).await?;
    for (index, expected) in inputs.iter().enumerate() {
        let row = transaction::Entity::find()
            .filter(transaction::Column::Hash.eq(hyperlane_core::h512_to_bytes(
                &H512::from_low_u64_be(100 + index as u64),
            )))
            .one(&db.0)
            .await?
            .unwrap();
        assert_eq!(&row.raw_input_data, expected);
    }
    Ok(())
}
