use migration::MigratorTrait;
use sea_orm::{Database, DbErr};
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use hyperlane_core::{BlockInfo, H256};

use crate::db::ScraperDb;

const TEST_DOMAIN: u32 = 1; // ethereum domain from migration

/// Helper to create a block info
fn make_block(height: u64, hash: H256, timestamp: u64) -> BlockInfo {
    BlockInfo {
        hash,
        timestamp,
        number: height,
    }
}

/// Tests store_blocks() with a real postgres instance using testcontainers
/// This test verifies:
/// 1. New blocks are inserted successfully
/// 2. Duplicate blocks (same hash) are handled with DO NOTHING
/// 3. Duplicate blocks (same domain+height) are handled with DO NOTHING
/// 4. Multiple blocks can be inserted in one call
#[tokio::test]
async fn test_store_blocks_real_postgres() -> Result<(), DbErr> {
    // Start a Postgres container
    let postgres_container = Postgres::default().start().await.unwrap();

    // Get connection details from the container
    let host_port = postgres_container.get_host_port_ipv4(5432).await.unwrap();
    let postgres_url = format!("postgresql://postgres:postgres@127.0.0.1:{host_port}/postgres");

    // Connect to database
    let db = Database::connect(&postgres_url).await?;

    // Run migrations to create schema
    migration::Migrator::up(&db, None).await?;

    let scraper_db = ScraperDb::with_connection(Database::connect(&postgres_url).await?);

    // Test 1: Insert new blocks
    let block1 = make_block(1, H256::from_low_u64_be(0x1), 1000);
    let block2 = make_block(2, H256::from_low_u64_be(0x2), 2000);
    let block3 = make_block(3, H256::from_low_u64_be(0x3), 3000);

    scraper_db
        .store_blocks(TEST_DOMAIN, vec![block1, block2, block3].into_iter())
        .await
        .expect("Should insert new blocks successfully");

    // Verify blocks were inserted
    let basic_blocks = scraper_db
        .get_block_basic(
            vec![
                &H256::from_low_u64_be(0x1),
                &H256::from_low_u64_be(0x2),
                &H256::from_low_u64_be(0x3),
            ]
            .into_iter(),
        )
        .await
        .expect("Should retrieve blocks");

    assert_eq!(basic_blocks.len(), 3, "Should have 3 blocks in database");

    // Test 2: Insert duplicate blocks (same hash) - should not fail
    let block1_duplicate = make_block(100, H256::from_low_u64_be(0x1), 5000);

    scraper_db
        .store_blocks(TEST_DOMAIN, vec![block1_duplicate].into_iter())
        .await
        .expect("Should handle duplicate hash with DO NOTHING");

    // Verify original block is unchanged
    let blocks = scraper_db
        .get_block_basic(vec![&H256::from_low_u64_be(0x1)].into_iter())
        .await
        .expect("Should retrieve block");

    assert_eq!(blocks.len(), 1, "Should still have 1 block with this hash");

    // Test 3: Insert duplicate blocks (same domain+height) - should not fail
    let block_duplicate_height = make_block(1, H256::from_low_u64_be(0x99), 6000);

    scraper_db
        .store_blocks(TEST_DOMAIN, vec![block_duplicate_height].into_iter())
        .await
        .expect("Should handle duplicate domain+height with DO NOTHING");

    // Verify we don't have the new hash
    let blocks = scraper_db
        .get_block_basic(vec![&H256::from_low_u64_be(0x99)].into_iter())
        .await
        .expect("Should retrieve blocks");

    assert_eq!(
        blocks.len(),
        0,
        "Should not insert block with duplicate height"
    );

    // Test 4: Insert multiple new blocks at once
    let blocks_batch: Vec<BlockInfo> = (10..20)
        .map(|i| make_block(i, H256::from_low_u64_be(i), i * 1000))
        .collect();

    scraper_db
        .store_blocks(TEST_DOMAIN, blocks_batch.into_iter())
        .await
        .expect("Should insert batch of blocks");

    // Verify batch insertion
    let hashes: Vec<H256> = (10..20).map(H256::from_low_u64_be).collect();
    let blocks = scraper_db
        .get_block_basic(hashes.iter())
        .await
        .expect("Should retrieve batch");

    assert_eq!(blocks.len(), 10, "Should have all 10 blocks from batch");

    // Test 5: Mix of new and duplicate blocks
    let block_new = make_block(50, H256::from_low_u64_be(0x50), 50000);
    let block_dup_hash = make_block(51, H256::from_low_u64_be(0x2), 51000); // hash 0x2 already exists
    let block_dup_height = make_block(3, H256::from_low_u64_be(0x51), 52000); // height 3 already exists

    scraper_db
        .store_blocks(
            TEST_DOMAIN,
            vec![block_new, block_dup_hash, block_dup_height].into_iter(),
        )
        .await
        .expect("Should handle mix of new and duplicate blocks");

    // Verify only the new block was inserted
    let blocks = scraper_db
        .get_block_basic(
            vec![&H256::from_low_u64_be(0x50), &H256::from_low_u64_be(0x51)].into_iter(),
        )
        .await
        .expect("Should retrieve blocks");

    assert_eq!(
        blocks.len(),
        1,
        "Should only have the new block (0x50), not the duplicates"
    );
    assert_eq!(
        blocks[0].hash,
        H256::from_low_u64_be(0x50),
        "Should be the new block"
    );

    // Clean up - drop all tables
    migration::Migrator::down(&db, None).await?;

    Ok(())
}
