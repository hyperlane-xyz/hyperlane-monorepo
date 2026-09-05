//! Hash lookup bounds, deduplication and error propagation.
use std::collections::BTreeMap;

use hyperlane_core::{h256_to_bytes, h512_to_bytes, H256, H512};
use sea_orm::{DatabaseBackend, DbErr, MockDatabase, Value};

use super::ScraperDb;

fn row(id: usize, hash: Vec<u8>) -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("id".to_owned(), Value::BigInt(Some(id as i64))),
        ("hash".to_owned(), Value::Bytes(Some(Box::new(hash)))),
    ])
}

#[tokio::test]
async fn hash_lookups_bound_large_inputs_and_deduplicate_across_chunks() {
    let blocks: Vec<_> = (0..66_000).map(H256::from_low_u64_be).collect();
    let txns: Vec<_> = (0..66_000).map(H512::from_low_u64_be).collect();
    let mut responses = Vec::new();
    for chunk in blocks.chunks(ScraperDb::HASH_LOOKUP_CHUNK_SIZE) {
        responses.push(vec![row(responses.len(), h256_to_bytes(&chunk[0]))]);
    }
    for chunk in txns.chunks(ScraperDb::HASH_LOOKUP_CHUNK_SIZE) {
        responses.push(vec![row(responses.len(), h512_to_bytes(&chunk[0]))]);
    }
    let db = ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results(responses)
            .into_connection(),
    );
    let found_blocks = db
        .get_block_basic(blocks.iter().chain(blocks[..1].iter()))
        .await
        .unwrap();
    let found_txns = db
        .get_txn_ids(txns.iter().chain(txns[..1].iter()))
        .await
        .unwrap();
    assert_eq!(found_blocks.len(), 2);
    assert_eq!(found_txns.len(), 2);
    for index in 0..2 {
        assert_eq!(found_blocks[index].hash, blocks[index * 65_000]);
        assert_eq!(found_blocks[index].id, index as i64);
        assert_eq!(found_txns[&txns[index * 65_000]], (index + 2) as i64);
    }
    let log = db.0.into_transaction_log();
    assert_eq!(log.len(), 4);
    for (index, query) in log.iter().enumerate() {
        let statement = &query.statements()[0];
        let values = &statement.values.as_ref().unwrap().0;
        assert_eq!(values.len(), if index % 2 == 1 { 1_000 } else { 65_000 });
    }
}

#[tokio::test]
async fn empty_hash_lookups_skip_database() {
    let db =
        ScraperDb::with_connection(MockDatabase::new(DatabaseBackend::Postgres).into_connection());
    assert!(db
        .get_block_basic(std::iter::empty())
        .await
        .unwrap()
        .is_empty());
    assert!(db.get_txn_ids(std::iter::empty()).await.unwrap().is_empty());
    assert!(db.0.into_transaction_log().is_empty());
}

#[tokio::test]
async fn hash_lookups_propagate_failed_tail_without_partial_results() {
    let blocks: Vec<_> = (0..65_001).map(H256::from_low_u64_be).collect();
    let txns: Vec<_> = (0..65_001).map(H512::from_low_u64_be).collect();
    for is_block in [true, false] {
        let db = ScraperDb::with_connection(
            MockDatabase::new(DatabaseBackend::Postgres)
                .append_query_results([vec![row(
                    1,
                    if is_block {
                        h256_to_bytes(&blocks[0])
                    } else {
                        h512_to_bytes(&txns[0])
                    },
                )]])
                .append_query_errors([DbErr::Custom("lookup tail failed".to_owned())])
                .into_connection(),
        );
        let error = if is_block {
            db.get_block_basic(blocks.iter()).await.unwrap_err()
        } else {
            db.get_txn_ids(txns.iter()).await.unwrap_err()
        };
        assert!(format!("{error:#}").contains("lookup tail failed"));
        assert_eq!(db.0.into_transaction_log().len(), 2);
    }
}
