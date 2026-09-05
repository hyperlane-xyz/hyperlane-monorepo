//! Sequence lookups select only event reconstruction fields.
use std::collections::BTreeMap;

use hyperlane_core::H256;
use sea_orm::{DatabaseBackend, DbErr, MockDatabase, Value};

use super::ScraperDb;

#[tokio::test]
async fn sequence_readers_project_payload_columns_and_preserve_absence() {
    let db = ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results(vec![Vec::<BTreeMap<String, Value>>::new(); 4])
            .into_connection(),
    );
    let address = H256::from_low_u64_be(42);
    assert!(db
        .retrieve_delivery_by_sequence(1, &address, 7)
        .await
        .unwrap()
        .is_none());
    assert!(db
        .retrieve_dispatched_message_by_nonce(1, &address, 7)
        .await
        .unwrap()
        .is_none());
    assert!(db
        .retrieve_payment_by_sequence(1, &address, 7)
        .await
        .unwrap()
        .is_none());
    assert!(db
        .retrieve_merkle_tree_insertion(1, &address, 7)
        .await
        .unwrap()
        .is_none());

    let log = db.0.into_transaction_log();
    assert_eq!(log.len(), 4);
    for (query, (table, columns)) in log.iter().zip([
        ("delivered_message", &["msg_id"][..]),
        (
            "message",
            &[
                "origin",
                "destination",
                "nonce",
                "sender",
                "recipient",
                "msg_body",
            ][..],
        ),
        (
            "gas_payment",
            &["msg_id", "destination", "payment", "gas_amount"][..],
        ),
        (
            "merkle_tree_insertion",
            &["leaf_index", "message_id", "block_number"][..],
        ),
    ]) {
        assert_eq!(query.statements().len(), 1);
        let statement = &query.statements()[0];
        let projection = columns
            .iter()
            .map(|column| format!("\"{table}\".\"{column}\""))
            .collect::<Vec<_>>()
            .join(", ");
        assert!(
            statement
                .sql
                .starts_with(&format!("SELECT {projection} FROM \"{table}\" WHERE ")),
            "{}",
            statement.sql
        );
        // Three original filter values and the existing LIMIT 1.
        assert_eq!(statement.values.as_ref().unwrap().0.len(), 4);
    }
}

#[tokio::test]
async fn sequence_readers_propagate_database_errors() {
    let db = ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_errors((0..4).map(|_| DbErr::Custom("sequence read failed".into())))
            .into_connection(),
    );
    let address = H256::zero();
    let errors = [
        db.retrieve_delivery_by_sequence(1, &address, 7)
            .await
            .unwrap_err(),
        db.retrieve_dispatched_message_by_nonce(1, &address, 7)
            .await
            .unwrap_err(),
        db.retrieve_payment_by_sequence(1, &address, 7)
            .await
            .unwrap_err(),
        db.retrieve_merkle_tree_insertion(1, &address, 7)
            .await
            .unwrap_err(),
    ];
    for error in errors {
        assert!(error.to_string().contains("sequence read failed"));
    }
}
