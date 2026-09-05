//! Regression tests for PostgreSQL statement bounds and atomic event writes.

use std::collections::BTreeMap;

use migration::MigratorTrait;
use sea_orm::{
    ColumnTrait, ConnectionTrait, Database, DatabaseBackend, EntityTrait, MockDatabase,
    MockExecResult, PaginatorTrait, QueryFilter, Value,
};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use hyperlane_core::{
    BlockInfo, InterchainGasPayment, LogMeta, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};

use super::{
    generated::{delivered_message, gas_payment},
    ScraperDb, StorableDelivery, StorablePayment, StorableTxn,
};

const DOMAIN: u32 = 1;

fn result(key: &str, value: i64) -> Vec<BTreeMap<String, Value>> {
    vec![BTreeMap::from([(
        key.to_owned(),
        Value::BigInt(Some(value)),
    )])]
}

fn payments(count: u32) -> Vec<InterchainGasPayment> {
    (0..count)
        .map(|index| InterchainGasPayment {
            message_id: H256::from_low_u64_be(u64::from(index)),
            destination: DOMAIN,
            payment: U256::from(1000),
            gas_amount: U256::from(12345),
        })
        .collect()
}

fn payment_rows<'a>(
    payments: &'a [InterchainGasPayment],
    meta: &'a LogMeta,
    txn_id: Option<i64>,
) -> Vec<StorablePayment<'a>> {
    payments
        .iter()
        .enumerate()
        .map(|(index, payment)| StorablePayment {
            payment,
            sequence: Some(i64::try_from(index).unwrap()),
            meta,
            txn_id,
        })
        .collect()
}

fn deliveries(count: u32, meta: &LogMeta) -> impl Iterator<Item = StorableDelivery<'_>> {
    (0..count).map(|index| StorableDelivery {
        message_id: H256::from_low_u64_be(u64::from(index)),
        sequence: Some(i64::from(index)),
        meta,
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
    assert_eq!(
        db.store_payments(DOMAIN, &H256::zero(), &[]).await.unwrap(),
        0
    );
    assert!(db.0.into_transaction_log().is_empty());
}

#[tokio::test]
async fn delivery_batches_bound_binds_and_preserve_small_fast_path() {
    for count in [1, 12_000] {
        let chunks = if count == 1 { 1 } else { 2 };
        let mut results = vec![result("max_id", 0)];
        results.extend((0..chunks).map(|_| result("id", 1)));
        results.push(result("num_items", i64::from(count)));
        let db = ScraperDb::with_connection(
            MockDatabase::new(DatabaseBackend::Postgres)
                .append_query_results(results)
                .into_connection(),
        );
        assert_eq!(
            db.store_deliveries(DOMAIN, H256::zero(), deliveries(count, &LogMeta::default()))
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
async fn payment_prefetch_and_insert_statements_are_bounded_and_deduplicated() {
    // 66,000 IDs exceed the old prefetch's 65,535 bind limit independently of INSERTs.
    for count in [5_000_u32, 66_000] {
        let chunks = usize::try_from(count.div_ceil(5_000)).unwrap();
        let mut results = vec![result("max_id", 0)];
        results.extend((0..chunks).map(|_| Vec::new()));
        results.extend((0..chunks).map(|_| result("id", 1)));
        results.push(result("num_items", i64::from(count)));
        let db = ScraperDb::with_connection(
            MockDatabase::new(DatabaseBackend::Postgres)
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }])
                .append_query_results(results)
                .into_connection(),
        );
        let mut payments = payments(count);
        payments.push(payments[0].clone()); // Prefetch and NULL-row identity must dedupe this.
        let meta = LogMeta::default();
        let rows = payment_rows(&payments, &meta, None);
        assert_eq!(
            db.store_payments(DOMAIN, &H256::zero(), &rows)
                .await
                .unwrap(),
            u64::from(count)
        );
        let log = db.0.into_transaction_log();
        assert_eq!(
            log.len(),
            1,
            "one transaction must retain the advisory lock throughout"
        );
        let statements = log[0].statements();
        assert_eq!(statements.first().unwrap().sql, "BEGIN");
        assert_eq!(statements.last().unwrap().sql, "COMMIT");
        assert_eq!(
            statements
                .iter()
                .filter(|statement| statement.sql.contains("pg_advisory_xact_lock"))
                .count(),
            1
        );
        let reads: Vec<_> = statements
            .iter()
            .filter(|statement| statement.sql.contains(" IN ("))
            .collect();
        assert_eq!(reads.len(), chunks);
        assert!(reads
            .iter()
            .all(|statement| statement.values.as_ref().unwrap().0.len() <= 5_002));
        let inserts: Vec<_> = statements
            .iter()
            .filter(|statement| statement.sql.starts_with("INSERT"))
            .collect();
        assert_eq!(inserts.len(), chunks);
        assert_eq!(inserts[0].values.as_ref().unwrap().0.len(), 55_000);
        assert!(statements.iter().all(|statement| statement
            .values
            .as_ref()
            .map_or(true, |values| values.0.len() <= usize::from(u16::MAX))));
    }
}

#[tokio::test]
async fn duplicate_keys_across_chunks_are_rejected() {
    let db = ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([result("max_id", 0)])
            .into_connection(),
    );
    let meta = LogMeta::default();
    let rows = deliveries(12_000, &meta).chain(deliveries(1, &meta));
    assert!(db
        .store_deliveries(DOMAIN, H256::zero(), rows)
        .await
        .unwrap_err()
        .to_string()
        .contains("Duplicate delivery"));
    let mut payments = payments(6_000);
    payments.push(payments[0].clone());
    assert!(db
        .store_payments(
            DOMAIN,
            &H256::zero(),
            &payment_rows(&payments, &meta, Some(1))
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("Duplicate resolved gas payment"));
    let log = db.0.into_transaction_log();
    assert!(log.is_empty());
}

async fn seed_transaction(db: &ScraperDb, index: u64) -> eyre::Result<i64> {
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
    let meta = LogMeta::default();
    let address = H256::from_low_u64_be(1);

    assert_eq!(
        db.store_deliveries(DOMAIN, address, deliveries(12_000, &meta))
            .await?,
        12_000
    );
    assert_eq!(
        db.store_deliveries(DOMAIN, address, deliveries(12_000, &meta))
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
        deliveries(1, &meta).map(|mut row| {
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
            deliveries(12_000, &meta).map(|mut row| {
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
        db.store_deliveries(DOMAIN, address, deliveries(12_000, &meta))
            .await?,
        11_999
    );

    let payments = payments(6_000);
    let fallback = payment_rows(&payments, &meta, None);
    assert_eq!(db.store_payments(DOMAIN, &address, &fallback).await?, 6_000);
    assert_eq!(db.store_payments(DOMAIN, &address, &fallback).await?, 0);
    assert_eq!(gas_payment::Entity::find().count(&db.0).await?, 6_000);
    db.0.execute_unprepared("TRUNCATE gas_payment").await?;
    db.store_payments(DOMAIN, &address, &fallback[..1]).await?;
    let tx_id = seed_transaction(&db, 0).await?;
    let resolved = payment_rows(&payments, &meta, Some(tx_id));
    db.0.execute_unprepared("ALTER TABLE gas_payment ADD CONSTRAINT reject_payment_tail CHECK (sequence <> 5000 OR tx_id IS NULL)").await?;
    assert!(db
        .store_payments(DOMAIN, &address, &resolved)
        .await
        .is_err());
    assert_eq!(gas_payment::Entity::find().count(&db.0).await?, 1);
    assert_eq!(
        gas_payment::Entity::find()
            .filter(gas_payment::Column::TxId.is_null())
            .count(&db.0)
            .await?,
        1,
        "failed tail must restore the deleted NULL fallback row"
    );
    db.0.execute_unprepared("ALTER TABLE gas_payment DROP CONSTRAINT reject_payment_tail")
        .await?;
    assert_eq!(db.store_payments(DOMAIN, &address, &resolved).await?, 6_000);
    assert_eq!(gas_payment::Entity::find().count(&db.0).await?, 6_000);
    assert_eq!(
        gas_payment::Entity::find()
            .filter(gas_payment::Column::TxId.is_null())
            .count(&db.0)
            .await?,
        0
    );
    assert_eq!(
        db.store_payments(DOMAIN, &address, &fallback).await?,
        0,
        "later fallback replay must preserve resolved rows"
    );
    Ok(())
}
