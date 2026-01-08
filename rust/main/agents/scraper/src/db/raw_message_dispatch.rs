#![allow(dead_code)] // TODO: `rustc` 1.80.1 clippy issue

use eyre::Result;
use itertools::Itertools;
use sea_orm::{prelude::*, ActiveValue::*, Insert, QuerySelect, TransactionTrait};
use tracing::{debug, instrument, trace};

use hyperlane_core::{
    address_to_bytes, h256_to_bytes, h512_to_bytes, HyperlaneMessage, LogMeta, H256,
};
use migration::OnConflict;

use crate::date_time;
use crate::db::ScraperDb;

use super::generated::raw_message_dispatch;

/// Struct representing a raw message dispatch that can be stored in the database.
/// This contains all data available from the dispatch event log without requiring RPC calls.
#[derive(Debug, Clone)]
pub struct StorableRawMessageDispatch<'a> {
    pub msg: &'a HyperlaneMessage,
    pub meta: &'a LogMeta,
}

impl ScraperDb {
    /// Used for store_raw_message_dispatches().
    /// raw_message_dispatch::ActiveModel has 12 fields, on conflict has 1 column,
    /// update has 7 columns. So there should be about a maximum of 20 sql
    /// parameters per ActiveModel.
    /// u16::MAX (65_535u16) is the maximum amount of parameters we can
    /// have for Postgres. So 65000 / 20 = 3250
    const STORE_RAW_MESSAGE_DISPATCH_CHUNK_SIZE: usize = 3250;

    /// Get the latest raw message dispatch ID for a specific domain and mailbox.
    async fn latest_raw_dispatch_id(
        &self,
        origin_domain: u32,
        origin_mailbox: Vec<u8>,
    ) -> Result<i64> {
        let result = raw_message_dispatch::Entity::find()
            .select_only()
            .column_as(raw_message_dispatch::Column::Id.max(), "max_id")
            .filter(raw_message_dispatch::Column::OriginDomain.eq(origin_domain))
            .filter(raw_message_dispatch::Column::OriginMailbox.eq(origin_mailbox))
            .into_tuple::<Option<i64>>()
            .one(&self.0)
            .await?;

        Ok(result
            // Top level Option indicates some kind of error
            .ok_or_else(|| eyre::eyre!("Error getting latest raw dispatch id"))?
            // Inner Option indicates whether there was any data in the filter -
            // just default to 0 if there was no data
            .unwrap_or(0))
    }

    /// Count raw message dispatches with ID greater than the given ID for a specific domain and mailbox.
    async fn raw_dispatch_count_since_id(
        &self,
        origin_domain: u32,
        origin_mailbox: Vec<u8>,
        prev_id: i64,
    ) -> Result<u64> {
        Ok(raw_message_dispatch::Entity::find()
            .filter(raw_message_dispatch::Column::OriginDomain.eq(origin_domain))
            .filter(raw_message_dispatch::Column::OriginMailbox.eq(origin_mailbox))
            .filter(raw_message_dispatch::Column::Id.gt(prev_id))
            .count(&self.0)
            .await?)
    }

    /// Store raw message dispatches into the database.
    /// This method stores raw message dispatch data that comes directly from event logs,
    /// requiring zero RPC calls. This enables CCTP to query transaction hashes even when
    /// RPC providers are failing.
    #[instrument(skip_all)]
    pub async fn store_raw_message_dispatches(
        &self,
        origin_domain: u32,
        origin_mailbox: &H256,
        messages: impl Iterator<Item = StorableRawMessageDispatch<'_>>,
    ) -> Result<u64> {
        let origin_mailbox = address_to_bytes(origin_mailbox);

        let models: Vec<raw_message_dispatch::ActiveModel> = messages
            .map(|storable| raw_message_dispatch::ActiveModel {
                id: NotSet,
                time_created: Set(date_time::now()),
                msg_id: Unchanged(h256_to_bytes(&storable.msg.id())),
                origin_tx_hash: Set(h512_to_bytes(&storable.meta.transaction_id)),
                origin_block_hash: Set(h256_to_bytes(&storable.meta.block_hash)),
                origin_block_height: Set(storable.meta.block_number as i64),
                nonce: Set(storable.msg.nonce as i32),
                origin_domain: Unchanged(storable.msg.origin as i32),
                destination_domain: Set(storable.msg.destination as i32),
                sender: Set(address_to_bytes(&storable.msg.sender)),
                recipient: Set(address_to_bytes(&storable.msg.recipient)),
                origin_mailbox: Unchanged(origin_mailbox.clone()),
            })
            .collect_vec();

        trace!(?models, "Writing raw message dispatches to database");

        if models.is_empty() {
            debug!("Wrote zero new raw message dispatches to database");
            return Ok(0);
        }

        let latest_id_before = self
            .latest_raw_dispatch_id(origin_domain, origin_mailbox.clone())
            .await?;

        // Ensure all chunks are inserted or none at all
        self.0
            .transaction::<_, (), DbErr>(|txn| {
                Box::pin(async move {
                    // Insert raw message dispatches in chunks, to not run into
                    // "Too many arguments" error
                    for chunk in models.chunks(Self::STORE_RAW_MESSAGE_DISPATCH_CHUNK_SIZE) {
                        Insert::many(chunk.to_vec())
                            .on_conflict(
                                OnConflict::column(raw_message_dispatch::Column::MsgId)
                                    .update_columns([
                                        raw_message_dispatch::Column::TimeCreated,
                                        raw_message_dispatch::Column::OriginTxHash,
                                        raw_message_dispatch::Column::OriginBlockHash,
                                        raw_message_dispatch::Column::OriginBlockHeight,
                                        raw_message_dispatch::Column::DestinationDomain,
                                        raw_message_dispatch::Column::Sender,
                                        raw_message_dispatch::Column::Recipient,
                                    ])
                                    .to_owned(),
                            )
                            .exec(txn)
                            .await?;
                    }
                    Ok(())
                })
            })
            .await?;

        let new_dispatch_count = self
            .raw_dispatch_count_since_id(origin_domain, origin_mailbox, latest_id_before)
            .await?;

        debug!(
            messages = new_dispatch_count,
            "Wrote new raw message dispatches to database"
        );
        Ok(new_dispatch_count)
    }

    /// Get the raw message dispatch by message ID.
    #[instrument(skip(self))]
    pub async fn retrieve_raw_message_dispatch_by_id(
        &self,
        message_id: &H256,
    ) -> Result<Option<raw_message_dispatch::Model>> {
        let msg_id = h256_to_bytes(message_id);
        Ok(raw_message_dispatch::Entity::find()
            .filter(raw_message_dispatch::Column::MsgId.eq(msg_id))
            .one(&self.0)
            .await?)
    }
}

#[cfg(test)]
mod tests {
    use migration::MigratorTrait;
    use std::collections::BTreeMap;

    use sea_orm::{Database, DatabaseBackend, DbErr, MockDatabase, RuntimeErr, Value};
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;
    use time::macros::{date, time};
    use time::PrimitiveDateTime;

    use hyperlane_core::{
        address_to_bytes, h256_to_bytes, h512_to_bytes, HyperlaneMessage, LogMeta, H256, H512, U256,
    };

    use crate::db::generated::raw_message_dispatch;
    use crate::db::ScraperDb;

    use super::StorableRawMessageDispatch;

    /// Helper to create a test message with specific values
    fn create_test_message(nonce: u32, origin: u32, destination: u32) -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce,
            origin,
            destination,
            sender: H256::from_low_u64_be(100),
            recipient: H256::from_low_u64_be(200),
            body: vec![1, 2, 3, 4],
        }
    }

    /// Helper to create test log metadata
    fn create_test_meta(block_number: u64, tx_index: u64, log_index: u64) -> LogMeta {
        LogMeta {
            address: H256::from_low_u64_be(999),
            block_number,
            block_hash: H256::from_low_u64_be(block_number),
            transaction_id: H512::from_low_u64_be(tx_index),
            transaction_index: tx_index,
            log_index: U256::from(log_index),
        }
    }

    // ==================== StorableRawMessageDispatch Tests ====================

    #[test]
    fn test_storable_raw_message_dispatch_captures_all_fields() {
        let msg = create_test_message(42, 1, 2);
        let meta = create_test_meta(1000, 5, 10);

        let storable = StorableRawMessageDispatch {
            msg: &msg,
            meta: &meta,
        };

        // Verify message fields are accessible
        assert_eq!(storable.msg.nonce, 42);
        assert_eq!(storable.msg.origin, 1);
        assert_eq!(storable.msg.destination, 2);
        assert_eq!(storable.msg.sender, H256::from_low_u64_be(100));
        assert_eq!(storable.msg.recipient, H256::from_low_u64_be(200));

        // Verify meta fields are accessible (what CCTP needs!)
        assert_eq!(storable.meta.block_number, 1000);
        assert_eq!(storable.meta.transaction_id, H512::from_low_u64_be(5));
        assert_eq!(storable.meta.transaction_index, 5);
        assert_eq!(storable.meta.log_index, U256::from(10));
    }

    #[test]
    fn test_storable_preserves_message_id() {
        let msg = create_test_message(1, 100, 200);
        let meta = create_test_meta(1, 1, 1);

        let storable = StorableRawMessageDispatch {
            msg: &msg,
            meta: &meta,
        };

        // Message ID should be deterministic based on message content
        let expected_id = msg.id();
        assert_eq!(storable.msg.id(), expected_id);
    }

    // ==================== store_raw_message_dispatches Tests ====================

    #[tokio::test]
    async fn test_store_raw_message_dispatches_empty_returns_zero() {
        let mock_db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
        let scraper_db = ScraperDb::with_connection(mock_db);

        let messages: Vec<StorableRawMessageDispatch> = vec![];
        let result = scraper_db
            .store_raw_message_dispatches(1, &H256::zero(), messages.into_iter())
            .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);
    }

    /// Helper to create a mock model for insert results
    fn create_mock_model(id: i64, nonce: i32) -> raw_message_dispatch::Model {
        raw_message_dispatch::Model {
            id,
            time_created: PrimitiveDateTime::new(date!(2024 - 01 - 01), time!(0:00)),
            msg_id: vec![0u8; 32],
            origin_tx_hash: vec![0u8; 64],
            origin_block_hash: vec![0u8; 32],
            origin_block_height: 100,
            nonce,
            origin_domain: 1,
            destination_domain: 2,
            sender: vec![0u8; 32],
            recipient: vec![0u8; 32],
            origin_mailbox: vec![0u8; 32],
        }
    }

    #[tokio::test]
    async fn test_store_raw_message_dispatches_single_message() {
        // SeaORM's Insert with on_conflict uses RETURNING clause on Postgres.
        // We need to provide mock results for:
        // 1. latest_raw_dispatch_id query (SELECT MAX(id)) - returns model with id=0
        // 2. INSERT query - returns the inserted model
        // 3. raw_dispatch_count_since_id query (SELECT COUNT) - returns count=1
        let mock_db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([[create_mock_model(0, 0)]]) // latest_raw_dispatch_id
            .append_query_results([[create_mock_model(1, 1)]]) // INSERT
            .append_query_results([[{
                let count_result: BTreeMap<&str, Value> =
                    [("num_items", Into::<Value>::into(1i64))]
                        .into_iter()
                        .collect();
                count_result
            }]]) // raw_dispatch_count_since_id
            .into_connection();
        let scraper_db = ScraperDb::with_connection(mock_db);

        let msg = create_test_message(1, 1, 2);
        let meta = create_test_meta(100, 1, 0);
        let messages = vec![StorableRawMessageDispatch {
            msg: &msg,
            meta: &meta,
        }];

        let result = scraper_db
            .store_raw_message_dispatches(1, &H256::from_low_u64_be(999), messages.into_iter())
            .await;

        assert!(result.is_ok(), "Expected Ok, got Err: {:?}", result.err());
        assert_eq!(result.unwrap(), 1);
    }

    #[tokio::test]
    async fn test_store_raw_message_dispatches_multiple_messages() {
        const MESSAGE_COUNT: usize = 100;

        // SeaORM's Insert with on_conflict uses RETURNING clause on Postgres.
        // Provide mock results for:
        // 1. latest_raw_dispatch_id query
        // 2. INSERT query - all inserted records
        // 3. raw_dispatch_count_since_id query
        let mock_results: Vec<raw_message_dispatch::Model> = (0..MESSAGE_COUNT)
            .map(|i| create_mock_model(i as i64 + 1, i as i32))
            .collect();
        let count_result: BTreeMap<&str, Value> =
            [("num_items", Into::<Value>::into(MESSAGE_COUNT as i64))]
                .into_iter()
                .collect();

        let mock_db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([[create_mock_model(0, 0)]]) // latest_raw_dispatch_id
            .append_query_results([mock_results]) // INSERT
            .append_query_results([[count_result]]) // raw_dispatch_count_since_id
            .into_connection();
        let scraper_db = ScraperDb::with_connection(mock_db);

        let messages: Vec<HyperlaneMessage> = (0..MESSAGE_COUNT)
            .map(|i| create_test_message(i as u32, 1, 2))
            .collect();
        let metas: Vec<LogMeta> = (0..MESSAGE_COUNT)
            .map(|i| create_test_meta(100 + i as u64, i as u64, i as u64))
            .collect();

        let storables: Vec<StorableRawMessageDispatch> = messages
            .iter()
            .zip(metas.iter())
            .map(|(msg, meta)| StorableRawMessageDispatch { msg, meta })
            .collect();

        let result = scraper_db
            .store_raw_message_dispatches(1, &H256::from_low_u64_be(999), storables.into_iter())
            .await;

        assert!(result.is_ok(), "Expected Ok, got Err: {:?}", result.err());
        assert_eq!(result.unwrap(), MESSAGE_COUNT as u64);
    }

    #[tokio::test]
    async fn test_store_raw_message_dispatches_handles_db_error() {
        // Use append_query_errors since INSERT with on_conflict uses RETURNING
        let mock_db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_errors([DbErr::Exec(RuntimeErr::Internal(
                "Database connection lost".to_string(),
            ))])
            .into_connection();
        let scraper_db = ScraperDb::with_connection(mock_db);

        let msg = create_test_message(1, 1, 2);
        let meta = create_test_meta(100, 1, 0);
        let messages = vec![StorableRawMessageDispatch {
            msg: &msg,
            meta: &meta,
        }];

        let result = scraper_db
            .store_raw_message_dispatches(1, &H256::from_low_u64_be(999), messages.into_iter())
            .await;

        assert!(result.is_err());
    }

    // ==================== retrieve_raw_message_dispatch_by_id Tests ====================

    #[tokio::test]
    async fn test_retrieve_raw_message_dispatch_by_id_found() {
        let msg = create_test_message(42, 1, 2);
        let msg_id = msg.id();

        let mock_model = raw_message_dispatch::Model {
            id: 1,
            time_created: PrimitiveDateTime::new(date!(2024 - 01 - 01), time!(12:00)),
            msg_id: h256_to_bytes(&msg_id),
            origin_tx_hash: vec![0u8; 64],
            origin_block_hash: vec![0u8; 32],
            origin_block_height: 1000,
            nonce: 42,
            origin_domain: 1,
            destination_domain: 2,
            sender: address_to_bytes(&msg.sender),
            recipient: address_to_bytes(&msg.recipient),
            origin_mailbox: vec![0u8; 32],
        };

        let mock_db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([[mock_model.clone()]])
            .into_connection();
        let scraper_db = ScraperDb::with_connection(mock_db);

        let result = scraper_db
            .retrieve_raw_message_dispatch_by_id(&msg_id)
            .await;

        assert!(result.is_ok());
        let model = result.unwrap();
        assert!(model.is_some());

        let model = model.unwrap();
        assert_eq!(model.nonce, 42);
        assert_eq!(model.origin_domain, 1);
        assert_eq!(model.destination_domain, 2);
        assert_eq!(model.origin_block_height, 1000);
    }

    #[tokio::test]
    async fn test_retrieve_raw_message_dispatch_by_id_not_found() {
        let mock_db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([Vec::<raw_message_dispatch::Model>::new()])
            .into_connection();
        let scraper_db = ScraperDb::with_connection(mock_db);

        let result = scraper_db
            .retrieve_raw_message_dispatch_by_id(&H256::from_low_u64_be(99999))
            .await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_retrieve_raw_message_dispatch_handles_db_error() {
        let mock_db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_errors([DbErr::Exec(RuntimeErr::Internal(
                "Query failed".to_string(),
            ))])
            .into_connection();
        let scraper_db = ScraperDb::with_connection(mock_db);

        let result = scraper_db
            .retrieve_raw_message_dispatch_by_id(&H256::zero())
            .await;

        assert!(result.is_err());
    }

    // ==================== Integration Test (uses testcontainers) ====================

    /// Integration test with real PostgreSQL using testcontainers.
    /// This test verifies:
    /// 1. Messages are stored successfully
    /// 2. Messages can be retrieved by ID
    /// 3. Duplicate messages (same msg_id) are handled with ON CONFLICT UPDATE
    #[tokio::test]
    async fn test_raw_message_dispatch_real_postgres() -> eyre::Result<()> {
        const MESSAGE_COUNT: usize = 100;

        // Start a Postgres container
        let postgres_container = Postgres::default().start().await.unwrap();

        // Get connection details from the container
        let host_port = postgres_container.get_host_port_ipv4(5432).await.unwrap();
        let postgres_url = format!("postgresql://postgres:postgres@127.0.0.1:{host_port}/postgres");

        // Connect to database and run migrations
        let db = Database::connect(&postgres_url).await?;
        migration::Migrator::up(&db, None).await?;

        let scraper_db = ScraperDb::with_connection(Database::connect(&postgres_url).await?);

        // Create test messages
        let messages: Vec<HyperlaneMessage> = (0..MESSAGE_COUNT)
            .map(|i| create_test_message(i as u32, 1, 2))
            .collect();
        let metas: Vec<LogMeta> = (0..MESSAGE_COUNT)
            .map(|i| create_test_meta(1000 + i as u64, i as u64, i as u64))
            .collect();

        let storables: Vec<StorableRawMessageDispatch> = messages
            .iter()
            .zip(metas.iter())
            .map(|(msg, meta)| StorableRawMessageDispatch { msg, meta })
            .collect();

        // Test 1: Store messages
        let store_result = scraper_db
            .store_raw_message_dispatches(1, &H256::from_low_u64_be(999), storables.into_iter())
            .await;
        assert!(
            store_result.is_ok(),
            "Store failed: {:?}",
            store_result.err()
        );
        assert_eq!(store_result.unwrap(), MESSAGE_COUNT as u64);

        // Test 2: Retrieve and verify first message
        let msg_id = messages[0].id();
        let retrieve_result = scraper_db
            .retrieve_raw_message_dispatch_by_id(&msg_id)
            .await;
        assert!(retrieve_result.is_ok());

        let model = retrieve_result.unwrap().expect("Message should exist");
        assert_eq!(model.nonce, 0);
        assert_eq!(model.origin_domain, 1);
        assert_eq!(model.destination_domain, 2);
        assert_eq!(model.origin_block_height, 1000);

        // Test 3: Retrieve last message
        let last_msg_id = messages[MESSAGE_COUNT - 1].id();
        let last_result = scraper_db
            .retrieve_raw_message_dispatch_by_id(&last_msg_id)
            .await?
            .expect("Last message should exist");
        assert_eq!(last_result.nonce, (MESSAGE_COUNT - 1) as i32);

        // Test 4: Duplicate handling (same message ID should update, not fail)
        let storables_dup: Vec<StorableRawMessageDispatch> = messages
            .iter()
            .take(10)
            .zip(metas.iter().take(10))
            .map(|(msg, meta)| StorableRawMessageDispatch { msg, meta })
            .collect();

        let dup_result = scraper_db
            .store_raw_message_dispatches(1, &H256::from_low_u64_be(999), storables_dup.into_iter())
            .await;
        assert!(
            dup_result.is_ok(),
            "Duplicate handling failed: {:?}",
            dup_result.err()
        );

        // Test 5: Non-existent message returns None
        let nonexistent = scraper_db
            .retrieve_raw_message_dispatch_by_id(&H256::from_low_u64_be(0xDEAD))
            .await?;
        assert!(nonexistent.is_none());

        // Clean up
        migration::Migrator::down(&db, None).await?;

        Ok(())
    }

    // ==================== CCTP-specific Scenario Tests ====================

    /// Test that verifies the key CCTP use case: retrieving tx_hash by message ID
    #[tokio::test]
    async fn test_cctp_scenario_tx_hash_retrieval() {
        // Simulate what CCTP needs: find origin_tx_hash for a message ID
        let msg = create_test_message(100, 1, 137); // origin=1, dest=137 (Polygon)
        let tx_hash = H512::from_low_u64_be(0xDEADBEEF);
        let meta = LogMeta {
            address: H256::from_low_u64_be(999),
            block_number: 12345,
            block_hash: H256::from_low_u64_be(12345),
            transaction_id: tx_hash,
            transaction_index: 7,
            log_index: U256::from(3),
        };

        let mock_model = raw_message_dispatch::Model {
            id: 1,
            time_created: PrimitiveDateTime::new(date!(2024 - 01 - 01), time!(12:00)),
            msg_id: h256_to_bytes(&msg.id()),
            origin_tx_hash: h512_to_bytes(&tx_hash),
            origin_block_hash: h256_to_bytes(&meta.block_hash),
            origin_block_height: 12345,
            nonce: 100,
            origin_domain: 1,
            destination_domain: 137,
            sender: address_to_bytes(&msg.sender),
            recipient: address_to_bytes(&msg.recipient),
            origin_mailbox: vec![0u8; 32],
        };

        let mock_db = MockDatabase::new(DatabaseBackend::Postgres)
            .append_query_results([[mock_model]])
            .into_connection();
        let scraper_db = ScraperDb::with_connection(mock_db);

        // CCTP queries by message ID to get tx_hash
        let result = scraper_db
            .retrieve_raw_message_dispatch_by_id(&msg.id())
            .await
            .unwrap()
            .expect("CCTP: Message must be found");

        // Verify tx_hash is correct - this is what CCTP uses to fetch the receipt
        assert_eq!(result.origin_tx_hash, h512_to_bytes(&tx_hash));
        assert_eq!(result.origin_block_height, 12345);
    }
}
