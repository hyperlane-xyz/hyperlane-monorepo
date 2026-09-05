use std::collections::BTreeMap;

use hyperlane_core::{BlockInfo, TxnInfo, TxnReceiptInfo, H512, U256};
use migration::MigratorTrait;
use sea_orm::{Database, DatabaseBackend, DbErr, MockDatabase, Value};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use super::*;
use crate::db::StorableTxn;

fn swap() -> SameChainCcrSwap {
    SameChainCcrSwap {
        domain: 1,
        source_router: H256::from_low_u64_be(11),
        destination_router: H256::from_low_u64_be(12),
        amount_received: U256::from(1234),
        recipient: H256::from_low_u64_be(13),
    }
}

fn result(key: &str, value: Value) -> Vec<BTreeMap<String, Value>> {
    vec![BTreeMap::from([(key.to_owned(), value)])]
}

#[tokio::test]
async fn ccr_presence_preserves_states_and_command_counts() {
    for (presence, expected_count, commands) in
        [(Some(true), 0, 1), (Some(false), 1, 4), (None, 1, 8)]
    {
        let mut results = vec![presence
            .map(|b| result("delivery_stored", Value::Bool(Some(b))))
            .unwrap_or_default()];
        if presence.is_none() {
            results.push(Vec::new()); // No prior nonce.
            results.extend([
                result("max_id", Value::BigInt(Some(0))),
                result("id", Value::BigInt(Some(1))),
                result("num_items", Value::BigInt(Some(1))),
            ]);
        }
        if presence != Some(true) {
            results.extend([
                result("max_id", Value::BigInt(Some(0))),
                result("id", Value::BigInt(Some(1))),
                result("num_items", Value::BigInt(Some(1))),
            ]);
        }
        let db = ScraperDb::with_connection(
            MockDatabase::new(DatabaseBackend::Postgres)
                .append_query_results(results)
                .into_connection(),
        );
        let swap = swap();
        let meta = LogMeta::default();
        assert_eq!(
            db.store_ccr_swaps_as_messages(
                1,
                &[StorableCcrSwap {
                    swap: &swap,
                    meta: &meta,
                    txn_id: 1
                }]
            )
            .await
            .unwrap(),
            expected_count
        );
        let log = db.0.into_transaction_log();
        assert_eq!(log.len(), commands);
        let query = &log[0].statements()[0];
        assert!(query.sql.starts_with("SELECT EXISTS(SELECT"));
        assert!(query.sql.contains("\"delivered_message\".\"msg_id\" ="));
        assert!(query.sql.contains("\"message\".\"msg_id\" ="));
        assert!(query.sql.contains("LIMIT"));
        let expected_id = Value::Bytes(Some(Box::new(h256_to_bytes(&synthetic_ccr_msg_id(&meta)))));
        assert_eq!(
            query
                .values
                .as_ref()
                .unwrap()
                .0
                .iter()
                .filter(|value| **value == expected_id)
                .count(),
            2
        );
    }
}

#[tokio::test]
async fn ccr_presence_errors_prevent_writes_and_empty_input_skips_queries() {
    let db = ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_errors([DbErr::Custom("presence failed".to_owned())])
            .into_connection(),
    );
    assert_eq!(db.store_ccr_swaps_as_messages(1, &[]).await.unwrap(), 0);
    let swap = swap();
    let meta = LogMeta::default();
    assert!(db
        .store_ccr_swaps_as_messages(
            1,
            &[StorableCcrSwap {
                swap: &swap,
                meta: &meta,
                txn_id: 1
            }]
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("presence failed"));
    assert_eq!(db.0.into_transaction_log().len(), 1);
}

#[tokio::test]
async fn ccr_presence_repairs_partial_and_orphan_pairs_in_postgres() -> eyre::Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let block_hash = H256::from_low_u64_be(100);
    let block_id = db
        .store_blocks(
            1,
            [BlockInfo {
                hash: block_hash,
                timestamp: 1_700_000_000,
                number: 50,
            }]
            .into_iter(),
        )
        .await?[0]
        .id;
    let tx_hash = H512::from_low_u64_be(101);
    let txn_id = db
        .store_txns(
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
        .await?[&tx_hash];
    let swap = swap();
    let meta = LogMeta {
        transaction_id: tx_hash,
        block_hash,
        block_number: 50,
        ..Default::default()
    };
    let row = || StorableCcrSwap {
        swap: &swap,
        meta: &meta,
        txn_id,
    };
    let msg_id = synthetic_ccr_msg_id(&meta);
    assert_eq!(db.ccr_pair_presence(msg_id).await?, None);
    // Repeated input must insert one pair, then recognize the pair immediately.
    assert_eq!(db.store_ccr_swaps_as_messages(1, &[row(), row()]).await?, 1);
    assert_eq!(db.ccr_pair_presence(msg_id).await?, Some(true));
    let original = message::Entity::find().one(&db.0).await?.unwrap();
    assert_eq!(original.nonce, 0);
    assert_eq!(db.store_ccr_swaps_as_messages(1, &[row()]).await?, 0);

    delivered_message::Entity::delete_many()
        .filter(delivered_message::Column::MsgId.eq(h256_to_bytes(&msg_id)))
        .exec(&db.0)
        .await?;
    // An unrelated delivery must not cause the partial pair to appear complete.
    db.store_deliveries(
        1,
        swap.destination_router,
        [StorableDelivery {
            message_id: H256::from_low_u64_be(999),
            sequence: None,
            meta: &meta,
            txn_id: Some(txn_id),
        }]
        .into_iter(),
    )
    .await?;
    assert_eq!(db.ccr_pair_presence(msg_id).await?, Some(false));
    assert_eq!(db.store_ccr_swaps_as_messages(1, &[row()]).await?, 1);
    assert_eq!(message::Entity::find().one(&db.0).await?.unwrap(), original);

    // Retain another message so orphan repair must allocate MAX(nonce) + 1.
    let other_meta = LogMeta {
        log_index: U256::one(),
        ..meta.clone()
    };
    assert_eq!(
        db.store_ccr_swaps_as_messages(
            1,
            &[StorableCcrSwap {
                swap: &swap,
                meta: &other_meta,
                txn_id
            }]
        )
        .await?,
        1
    );
    // An orphan delivery must not suppress message creation or nonce allocation.
    message::Entity::delete_many()
        .filter(message::Column::MsgId.eq(h256_to_bytes(&msg_id)))
        .exec(&db.0)
        .await?;
    assert_eq!(db.ccr_pair_presence(msg_id).await?, None);
    assert_eq!(db.store_ccr_swaps_as_messages(1, &[row(), row()]).await?, 1);
    assert_eq!(db.ccr_pair_presence(msg_id).await?, Some(true));
    let restored = message::Entity::find()
        .filter(message::Column::MsgId.eq(h256_to_bytes(&msg_id)))
        .one(&db.0)
        .await?
        .unwrap();
    assert_eq!(restored.msg_id, original.msg_id);
    assert_eq!(restored.nonce, 2);
    assert_eq!(restored.msg_body, original.msg_body);
    assert_eq!(restored.origin_tx_id, Some(txn_id));
    Ok(())
}
