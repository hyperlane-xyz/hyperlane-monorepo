use std::collections::BTreeMap;

use migration::MigratorTrait;
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, MockDatabase, PaginatorTrait, Value};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use super::*;

// Matches the observed 86,580-bind range: five parameters per insertion.
const ROW_COUNT: u32 = 17_316;
const DOMAIN: u32 = 1;

fn insertions() -> Vec<MerkleTreeInsertion> {
    (0..ROW_COUNT)
        .map(|index| MerkleTreeInsertion::new(index, H256::from_low_u64_be(u64::from(index))))
        .collect()
}

fn rows(
    insertions: &[MerkleTreeInsertion],
) -> impl Iterator<Item = StorableMerkleTreeInsertion<'_>> {
    insertions
        .iter()
        .map(|insertion| StorableMerkleTreeInsertion {
            insertion,
            block_number: 20_000,
        })
}

#[tokio::test]
async fn merkle_insert_statements_stay_below_postgres_bind_limit() {
    let connection = MockDatabase::new(DatabaseBackend::Postgres)
        .append_query_results([
            [BTreeMap::from([("id", Value::BigInt(Some(1)))])],
            [BTreeMap::from([("id", Value::BigInt(Some(2)))])],
        ])
        .into_connection();
    let db = ScraperDb::with_connection(connection);
    assert_eq!(
        db.store_merkle_tree_insertions(DOMAIN, &H256::zero(), rows(&insertions()))
            .await
            .unwrap(),
        u64::from(ROW_COUNT)
    );
    let transactions = db.0.into_transaction_log();
    assert_eq!(transactions.len(), 1, "all chunks must share a transaction");
    let statements = transactions[0].statements();
    assert_eq!(statements.first().unwrap().sql, "BEGIN");
    assert_eq!(statements.last().unwrap().sql, "COMMIT");
    assert_eq!(statements.len(), 4);
    let bind_counts: Vec<_> = statements
        .iter()
        .filter(|statement| statement.sql.starts_with("INSERT"))
        .map(|statement| statement.values.as_ref().unwrap().0.len())
        .collect();
    assert_eq!(bind_counts, [65_000, 21_580]);
    assert!(bind_counts
        .iter()
        .all(|count| *count <= usize::from(u16::MAX)));
}

#[tokio::test]
async fn merkle_small_insert_keeps_one_statement_and_empty_insert_skips_sql() {
    let db = ScraperDb::with_connection(
        MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([[BTreeMap::from([("id", Value::BigInt(Some(1)))])]])
            .into_connection(),
    );
    assert_eq!(
        db.store_merkle_tree_insertions(DOMAIN, &H256::zero(), rows(&[]))
            .await
            .unwrap(),
        0
    );
    let insertion = MerkleTreeInsertion::new(1, H256::zero());
    assert_eq!(
        db.store_merkle_tree_insertions(DOMAIN, &H256::zero(), rows(&[insertion]))
            .await
            .unwrap(),
        1
    );
    let transactions = db.0.into_transaction_log();
    assert_eq!(transactions.len(), 1);
    let statements = transactions[0].statements();
    assert_eq!(statements.len(), 1);
    assert!(statements[0].sql.starts_with("INSERT"));
    assert_eq!(statements[0].values.as_ref().unwrap().0.len(), 5);
}

#[tokio::test]
async fn merkle_duplicate_leaf_across_chunks_is_rejected_before_writes() {
    let db =
        ScraperDb::with_connection(MockDatabase::new(DatabaseBackend::Postgres).into_connection());
    let mut insertions = insertions();
    insertions.push(insertions[0]);
    let error = db
        .store_merkle_tree_insertions(DOMAIN, &H256::zero(), rows(&insertions))
        .await
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("Duplicate Merkle tree leaf index 0"));
    assert!(db.0.into_transaction_log().is_empty());
}

#[tokio::test]
async fn merkle_bulk_insert_is_replayable_and_rolls_back_failed_tail() -> eyre::Result<()> {
    let postgres = Postgres::default().start().await?;
    let port = postgres.get_host_port_ipv4(5432).await?;
    let connection = Database::connect(format!(
        "postgresql://postgres:postgres@127.0.0.1:{port}/postgres"
    ))
    .await?;
    migration::Migrator::up(&connection, None).await?;
    let db = ScraperDb::with_connection(connection);
    let hook = H256::from_low_u64_be(1);
    let insertions = insertions();

    for _ in 0..2 {
        assert_eq!(
            db.store_merkle_tree_insertions(DOMAIN, &hook, rows(&insertions))
                .await?,
            u64::from(ROW_COUNT)
        );
        assert_eq!(
            merkle_tree_insertion::Entity::find().count(&db.0).await?,
            u64::from(ROW_COUNT),
            "replay must not duplicate rows"
        );
    }
    for index in [0, 12_999, 13_000, ROW_COUNT - 1] {
        assert_eq!(
            db.retrieve_merkle_tree_insertion(DOMAIN, &hook, index)
                .await?,
            Some((insertions[usize::try_from(index)?], 20_000))
        );
    }

    // Retain one existing row, then fail the first row of the second chunk.
    // Both first-chunk inserts and updates must roll back with the failure.
    db.0.execute_unprepared("TRUNCATE merkle_tree_insertion")
        .await?;
    let original = MerkleTreeInsertion::new(0, H256::repeat_byte(0xff));
    db.store_merkle_tree_insertions(
        DOMAIN,
        &hook,
        [StorableMerkleTreeInsertion {
            insertion: &original,
            block_number: 10_000,
        }]
        .into_iter(),
    )
    .await?;
    db.0.execute_unprepared(
        "ALTER TABLE merkle_tree_insertion ADD CONSTRAINT reject_test_tail CHECK (leaf_index <> 13000)"
    ).await?;
    assert!(db
        .store_merkle_tree_insertions(DOMAIN, &hook, rows(&insertions))
        .await
        .is_err());
    assert_eq!(merkle_tree_insertion::Entity::find().count(&db.0).await?, 1);
    assert_eq!(
        db.retrieve_merkle_tree_insertion(DOMAIN, &hook, 0).await?,
        Some((original, 10_000)),
        "failed tail must also roll back updates to earlier existing rows"
    );

    db.0.execute_unprepared("ALTER TABLE merkle_tree_insertion DROP CONSTRAINT reject_test_tail")
        .await?;
    assert_eq!(
        db.store_merkle_tree_insertions(DOMAIN, &hook, rows(&insertions))
            .await?,
        u64::from(ROW_COUNT)
    );
    assert_eq!(
        merkle_tree_insertion::Entity::find().count(&db.0).await?,
        u64::from(ROW_COUNT)
    );
    assert_eq!(
        db.retrieve_merkle_tree_insertion(DOMAIN, &hook, 0).await?,
        Some((insertions[0], 20_000))
    );
    Ok(())
}
