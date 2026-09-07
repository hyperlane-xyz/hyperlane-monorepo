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
    // 66,000 IDs exceed the old prefetch's 65,535 bind limit independently of INSERT statements.
    for count in [5_000_u32, 66_000] {
        let chunks = usize::try_from(count.div_ceil(5_000)).unwrap();
        let mut results = (0..chunks).map(|_| Vec::new()).collect::<Vec<_>>();
        results.push(result("max_id", 0));
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
        assert!(reads.iter().all(|statement| statement.sql.starts_with(
            "SELECT \"gas_payment\".\"msg_id\", \"gas_payment\".\"log_index\", \"gas_payment\".\"tx_id\" FROM"
        )));
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
async fn payment_fallback_replays_skip_count_baseline() {
    for existing_tx_id in [None, Some(7)] {
        let payments = payments(1);
        let meta = LogMeta::default();
        let existing = vec![BTreeMap::from([
            (
                "0".to_owned(),
                Value::Bytes(Some(Box::new(hyperlane_core::h256_to_bytes(
                    &payments[0].message_id,
                )))),
            ),
            ("1".to_owned(), Value::BigInt(Some(0))),
            ("2".to_owned(), Value::BigInt(existing_tx_id)),
        ])];
        let db = ScraperDb::with_connection(
            MockDatabase::new(DatabaseBackend::Postgres)
                .append_exec_results([MockExecResult {
                    last_insert_id: 0,
                    rows_affected: 1,
                }])
                .append_query_results([existing])
                .into_connection(),
        );
        assert_eq!(
            db.store_payments(DOMAIN, &H256::zero(), &payment_rows(&payments, &meta, None))
                .await
                .unwrap(),
            0
        );
        let log = db.0.into_transaction_log();
        let statements = log[0].statements();
        assert_eq!(statements.len(), 4);
        assert_eq!(statements[0].sql, "BEGIN");
        assert!(statements[1].sql.contains("pg_advisory_xact_lock"));
        assert!(statements[2].sql.contains(" IN ("));
        assert_eq!(statements[3].sql, "COMMIT");
    }
}

#[tokio::test]
async fn payment_prefetch_and_baseline_errors_precede_writes() {
    for fail_prefetch in [true, false] {
        let mock =
            MockDatabase::new(DatabaseBackend::Postgres).append_exec_results([MockExecResult {
                last_insert_id: 0,
                rows_affected: 1,
            }]);
        let mock = if fail_prefetch {
            mock
        } else {
            mock.append_query_results([Vec::<BTreeMap<String, Value>>::new()])
        };
        let db = ScraperDb::with_connection(
            mock.append_query_errors([sea_orm::DbErr::Custom("read failed".to_owned())])
                .into_connection(),
        );
        let payments = payments(1);
        let meta = LogMeta::default();
        assert!(db
            .store_payments(DOMAIN, &H256::zero(), &payment_rows(&payments, &meta, None))
            .await
            .unwrap_err()
            .to_string()
            .contains("read failed"));
        let log = db.0.into_transaction_log();
        let statements = log[0].statements();
        assert_eq!(statements.last().unwrap().sql, "ROLLBACK");
        assert!(!statements
            .iter()
            .any(|s| s.sql.starts_with("INSERT") || s.sql.starts_with("DELETE")));
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
    let meta = LogMeta::default();
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
            meta: &meta,
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
async fn owned_raw_payloads_and_transaction_inputs_survive_storage() -> eyre::Result<()> {
    use super::generated::{raw_message_dispatch, transaction};
    use super::StorableRawMessageDispatch;
    use hyperlane_core::HyperlaneMessage;

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
    let messages: Vec<_> = (0..2_955u32)
        .map(|nonce| HyperlaneMessage {
            nonce,
            origin: DOMAIN,
            destination: DOMAIN,
            body: if nonce == 0 {
                vec![]
            } else {
                vec![(nonce % 251) as u8; 1_024]
            },
            ..Default::default()
        })
        .collect();
    let rows = || {
        messages
            .iter()
            .map(|msg| StorableRawMessageDispatch { msg, meta: &meta })
    };
    assert_eq!(
        db.store_raw_message_dispatches(DOMAIN, &address, rows())
            .await?,
        2_955
    );
    assert_eq!(
        db.store_raw_message_dispatches(DOMAIN, &address, rows())
            .await?,
        0
    );
    let stored = raw_message_dispatch::Entity::find().all(&db.0).await?;
    assert_eq!(stored.len(), messages.len());
    for row in stored {
        assert_eq!(
            row.msg_body.as_ref(),
            Some(&messages[row.nonce as usize].body)
        );
    }

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

#[tokio::test]
async fn payment_fallback_deletes_use_bounded_tuple_keys() {
    let payments = payments(6_000);
    let meta = LogMeta::default();
    let mut results = Vec::new();
    for chunk in payments.chunks(5_000) {
        // MockDatabase reads tuples by sorted-key position, not SQL column name.
        results.push(
            chunk
                .iter()
                .map(|payment| {
                    BTreeMap::from([
                        (
                            "0".to_owned(),
                            Value::Bytes(Some(Box::new(hyperlane_core::h256_to_bytes(
                                &payment.message_id,
                            )))),
                        ),
                        ("1".to_owned(), Value::BigInt(Some(0))),
                        ("2".to_owned(), Value::BigInt(None)),
                    ])
                })
                .collect(),
        );
    }
    results.push(result("max_id", 0));
    results.extend([result("id", 1), result("id", 2), result("num_items", 6_000)]);
    let db = ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_exec_results((0..3).map(|_| MockExecResult {
                last_insert_id: 0,
                rows_affected: 1,
            }))
            .append_query_results(results)
            .into_connection(),
    );
    assert_eq!(
        db.store_payments(
            DOMAIN,
            &H256::zero(),
            &payment_rows(&payments, &meta, Some(1))
        )
        .await
        .unwrap(),
        6_000
    );
    let log = db.0.into_transaction_log();
    assert_eq!(log.len(), 1);
    let statements = log[0].statements();
    assert_eq!(statements.len(), 11);
    let deletes: Vec<_> = statements
        .iter()
        .filter(|statement| statement.sql.starts_with("DELETE"))
        .collect();
    assert_eq!(deletes.len(), 2);
    assert_eq!(deletes[0].values.as_ref().unwrap().0.len(), 10_002);
    assert_eq!(deletes[1].values.as_ref().unwrap().0.len(), 2_002);
    for statement in deletes {
        assert!(statement.sql.contains("\"tx_id\" IS NULL"));
        assert!(statement.sql.contains("(\"msg_id\", \"log_index\") IN"));
    }
}

#[tokio::test]
async fn payment_fallback_deletes_preserve_neighbors_and_rollback_in_postgres() -> eyre::Result<()>
{
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let meta = LogMeta::default();
    let mut neighbor_meta = LogMeta::default();
    neighbor_meta.log_index = U256::one();
    let address = H256::from_low_u64_be(1);
    let other_address = H256::from_low_u64_be(2);
    let payments = payments(6_000);
    let mut fallback = payment_rows(&payments, &meta, None);
    for row in fallback.iter_mut().skip(1).step_by(2) {
        row.meta = &neighbor_meta;
    }
    db.store_payments(DOMAIN, &address, &fallback).await?;
    db.store_payments(DOMAIN, &other_address, &fallback[..1])
        .await?;
    db.store_payments(
        DOMAIN,
        &address,
        &payment_rows(&payments[..1], &neighbor_meta, None),
    )
    .await?;
    let other_domain = super::generated::domain::Entity::find()
        .filter(super::generated::domain::Column::Id.gt(1))
        .one(&db.0)
        .await?
        .unwrap()
        .id;
    db.store_payments(u32::try_from(other_domain)?, &address, &fallback[..1])
        .await?;
    let other_tx_id = seed_transaction(&db, 1).await?;
    db.0.execute(sea_orm::Statement::from_sql_and_values(DatabaseBackend::Postgres,
        "INSERT INTO gas_payment (time_created,domain,msg_id,payment,gas_amount,tx_id,log_index,origin,destination,interchain_gas_paymaster,sequence) SELECT time_created,domain,msg_id,payment,gas_amount,$1,log_index,origin,destination,interchain_gas_paymaster,sequence FROM gas_payment ORDER BY id LIMIT 1",
        [other_tx_id.into()],
    )).await?;
    let tx_id = seed_transaction(&db, 0).await?;
    let mut resolved = payment_rows(&payments, &meta, Some(tx_id));
    for row in resolved.iter_mut().skip(1).step_by(2) {
        row.meta = &neighbor_meta;
    }
    db.0.execute_unprepared("ALTER TABLE gas_payment ADD CONSTRAINT reject_repair_tail CHECK (sequence <> 5000 OR tx_id IS NULL)").await?;
    assert!(db
        .store_payments(DOMAIN, &address, &resolved)
        .await
        .is_err());
    assert_eq!(gas_payment::Entity::find().count(&db.0).await?, 6_004);
    assert_eq!(
        gas_payment::Entity::find()
            .filter(gas_payment::Column::TxId.is_null())
            .count(&db.0)
            .await?,
        6_003
    );
    db.0.execute_unprepared("ALTER TABLE gas_payment DROP CONSTRAINT reject_repair_tail")
        .await?;
    assert_eq!(db.store_payments(DOMAIN, &address, &resolved).await?, 6_000);
    assert_eq!(db.store_payments(DOMAIN, &address, &resolved).await?, 0);
    assert_eq!(gas_payment::Entity::find().count(&db.0).await?, 6_004);
    let neighbors = gas_payment::Entity::find()
        .filter(gas_payment::Column::TxId.is_null())
        .all(&db.0)
        .await?;
    assert_eq!(neighbors.len(), 3);
    assert!(neighbors.iter().any(
        |row| row.interchain_gas_paymaster == hyperlane_core::address_to_bytes(&other_address)
    ));
    assert!(neighbors.iter().any(|row| row.log_index == 1));
    assert!(neighbors.iter().any(|row| row.domain == other_domain));
    assert_eq!(
        gas_payment::Entity::find()
            .filter(gas_payment::Column::TxId.eq(other_tx_id))
            .count(&db.0)
            .await?,
        1
    );
    Ok(())
}
