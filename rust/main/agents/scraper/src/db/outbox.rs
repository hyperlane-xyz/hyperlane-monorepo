use eyre::Result;
use migration::OnConflict;
use sea_orm::{
    ActiveValue::*, ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, Order, QueryFilter,
    QueryOrder, QuerySelect, Statement, TransactionTrait,
};
use tracing::{debug, instrument};

use crate::date_time;
use crate::db::ScraperDb;

use super::generated::{block, indexing_checkpoint, outbox};

const OUTBOX_INDEXING_CHECKPOINT_EVENT_TYPE: &str = "indexing_checkpoint";
const OUTBOX_MESSAGE_EVENT_TYPE: &str = "message_dispatch";
const OUTBOX_DELIVERY_EVENT_TYPE: &str = "message_delivery";
const OUTBOX_GAS_PAYMENT_EVENT_TYPE: &str = "gas_payment";
const OUTBOX_MERKLE_TREE_INSERTION_EVENT_TYPE: &str = "merkle_tree_insertion";
const MESSAGE_SOURCE_TABLE: &str = "message";
const DELIVERED_MESSAGE_SOURCE_TABLE: &str = "delivered_message";
const GAS_PAYMENT_SOURCE_TABLE: &str = "gas_payment";
const MERKLE_TREE_INSERTION_SOURCE_TABLE: &str = "merkle_tree_insertion";
const INDEXING_CHECKPOINT_SOURCE_TABLE: &str = "indexing_checkpoint";
const MESSAGE_CURSOR_EVENT_TYPE: &str = "hyperlane_message_outbox";
const DELIVERY_CURSOR_EVENT_TYPE: &str = "delivery_outbox";
const GAS_PAYMENT_CURSOR_EVENT_TYPE: &str = "interchain_gas_payment_outbox";
const MERKLE_TREE_INSERTION_CURSOR_EVENT_TYPE: &str = "merkle_tree_insertion_outbox";
const REQUIRED_INDEXING_CHECKPOINT_COUNT: usize = 4;
const OUTBOX_BUILD_BLOCK_CHUNK: i64 = 10_000;
const OUTBOX_SOURCE_ROW_CHUNK: u64 = 5_000;
const OUTBOX_INSERT_ROW_CHUNK: usize = 5_000;

#[derive(Clone, Debug, FromQueryResult)]
struct OutboxSourceRow {
    id: i64,
    position: i64,
}

struct OutboxSourceBatch {
    rows: Vec<OutboxSourceRow>,
    exhausted: bool,
}

impl OutboxSourceBatch {
    fn from_rows(mut rows: Vec<OutboxSourceRow>) -> Self {
        let exhausted = rows.len() <= OUTBOX_SOURCE_ROW_CHUNK as usize;
        rows.truncate(OUTBOX_SOURCE_ROW_CHUNK as usize);
        Self { rows, exhausted }
    }
}

impl ScraperDb {
    /// Build outbox rows up to the current safe indexed position for a domain.
    ///
    /// If no outbox indexing checkpoint exists yet, this starts from the first
    /// indexed block for the domain and backfills through the safe position.
    #[instrument(skip(self))]
    pub async fn build_outbox(&self, domain: u32) -> Result<u64> {
        let Some(safe_position) = self.safe_outbox_position(domain).await? else {
            return Ok(0);
        };
        let Some(last_position) = self.last_outbox_position(domain).await? else {
            return Ok(0);
        };
        let target_position = if safe_position > last_position {
            safe_position.min(last_position.saturating_add(OUTBOX_BUILD_BLOCK_CHUNK))
        } else {
            safe_position
        };

        let messages = self.message_outbox_rows(domain, target_position).await?;
        let deliveries = self.delivery_outbox_rows(domain, target_position).await?;
        let gas_payments = self
            .gas_payment_outbox_rows(domain, target_position)
            .await?;
        let merkle_tree_insertions = self
            .merkle_tree_insertion_outbox_rows(domain, target_position)
            .await?;

        let sources_exhausted = messages.exhausted
            && deliveries.exhausted
            && gas_payments.exhausted
            && merkle_tree_insertions.exhausted;

        let capacity = messages
            .rows
            .len()
            .saturating_add(deliveries.rows.len())
            .saturating_add(gas_payments.rows.len())
            .saturating_add(merkle_tree_insertions.rows.len());
        let mut models = Vec::with_capacity(capacity);
        for row in messages.rows {
            models.push(outbox_model(
                domain,
                row.position,
                OUTBOX_MESSAGE_EVENT_TYPE,
                MESSAGE_SOURCE_TABLE,
                row.id,
            ));
        }
        for row in deliveries.rows {
            models.push(outbox_model(
                domain,
                row.position,
                OUTBOX_DELIVERY_EVENT_TYPE,
                DELIVERED_MESSAGE_SOURCE_TABLE,
                row.id,
            ));
        }
        for row in gas_payments.rows {
            models.push(outbox_model(
                domain,
                row.position,
                OUTBOX_GAS_PAYMENT_EVENT_TYPE,
                GAS_PAYMENT_SOURCE_TABLE,
                row.id,
            ));
        }
        for row in merkle_tree_insertions.rows {
            models.push(outbox_model(
                domain,
                row.position,
                OUTBOX_MERKLE_TREE_INSERTION_EVENT_TYPE,
                MERKLE_TREE_INSERTION_SOURCE_TABLE,
                row.id,
            ));
        }
        let checkpoint = (target_position > last_position && sources_exhausted).then(|| {
            outbox_model(
                domain,
                target_position,
                OUTBOX_INDEXING_CHECKPOINT_EVENT_TYPE,
                INDEXING_CHECKPOINT_SOURCE_TABLE,
                target_position,
            )
        });

        if models.is_empty() && checkpoint.is_none() {
            return Ok(0);
        }

        let txn = self.0.begin().await?;
        let inserted = u64::try_from(
            models
                .len()
                .saturating_add(usize::from(checkpoint.is_some())),
        )?;
        for chunk in outbox_insert_chunks(&models) {
            outbox::Entity::insert_many(chunk.iter().cloned())
                .on_conflict(outbox_conflict_clause())
                .exec(&txn)
                .await?;
        }
        if let Some(checkpoint) = checkpoint {
            outbox::Entity::insert(checkpoint)
                .on_conflict(outbox_conflict_clause())
                .exec(&txn)
                .await?;
        }
        txn.commit().await?;

        debug!(
            domain,
            safe_position, target_position, last_position, inserted, "Built outbox"
        );
        Ok(inserted)
    }

    async fn safe_outbox_position(&self, domain: u32) -> Result<Option<i64>> {
        let heights = indexing_checkpoint::Entity::find()
            .filter(indexing_checkpoint::Column::Domain.eq(domain))
            .filter(indexing_checkpoint::Column::EventType.is_in([
                MESSAGE_CURSOR_EVENT_TYPE,
                DELIVERY_CURSOR_EVENT_TYPE,
                GAS_PAYMENT_CURSOR_EVENT_TYPE,
                MERKLE_TREE_INSERTION_CURSOR_EVENT_TYPE,
            ]))
            .select_only()
            .column(indexing_checkpoint::Column::Height)
            .into_tuple::<i64>()
            .all(&self.0)
            .await?;

        if heights.len() < REQUIRED_INDEXING_CHECKPOINT_COUNT {
            return Ok(None);
        }

        Ok(heights.into_iter().min())
    }

    async fn last_outbox_position(&self, domain: u32) -> Result<Option<i64>> {
        if let Some(position) = outbox::Entity::find()
            .filter(outbox::Column::Domain.eq(domain))
            .filter(outbox::Column::EventType.eq(OUTBOX_INDEXING_CHECKPOINT_EVENT_TYPE))
            .order_by(outbox::Column::Position, Order::Desc)
            .select_only()
            .column(outbox::Column::Position)
            .into_tuple::<i64>()
            .one(&self.0)
            .await?
        {
            return Ok(Some(position));
        }

        Ok(self
            .first_indexed_block(domain)
            .await?
            .map(|height| height.saturating_sub(1)))
    }

    async fn first_indexed_block(&self, domain: u32) -> Result<Option<i64>> {
        Ok(block::Entity::find()
            .filter(block::Column::Domain.eq(domain))
            .select_only()
            .column_as(block::Column::Height.min(), "height")
            .into_tuple::<Option<i64>>()
            .one(&self.0)
            .await?
            .flatten())
    }

    async fn source_outbox_rows(
        &self,
        domain: u32,
        target_position: i64,
        event_type: &str,
        source_table: &str,
        domain_column: &str,
        transaction_column: &str,
    ) -> Result<OutboxSourceBatch> {
        let rows = OutboxSourceRow::find_by_statement(Statement::from_sql_and_values(
            self.0.get_database_backend(),
            format!(
                r#"
                SELECT source.id, block.height AS position
                FROM "{source_table}" source
                JOIN "transaction" source_tx
                  ON source_tx.id = source."{transaction_column}"
                JOIN block ON block.id = source_tx.block_id
                LEFT JOIN outbox
                  ON outbox.domain = $1
                 AND outbox.event_type = $2
                 AND outbox.source_id = source.id
                WHERE source."{domain_column}" = $1
                  AND block.height <= $3
                  AND outbox.id IS NULL
                ORDER BY source.id ASC
                LIMIT $4
                "#
            ),
            [
                (domain as i32).into(),
                event_type.into(),
                target_position.into(),
                (OUTBOX_SOURCE_ROW_CHUNK.saturating_add(1) as i64).into(),
            ],
        ))
        .all(&self.0)
        .await?;

        Ok(OutboxSourceBatch::from_rows(rows))
    }

    async fn message_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<OutboxSourceBatch> {
        self.source_outbox_rows(
            domain,
            safe_position,
            OUTBOX_MESSAGE_EVENT_TYPE,
            MESSAGE_SOURCE_TABLE,
            "origin",
            "origin_tx_id",
        )
        .await
    }

    async fn delivery_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<OutboxSourceBatch> {
        self.source_outbox_rows(
            domain,
            safe_position,
            OUTBOX_DELIVERY_EVENT_TYPE,
            DELIVERED_MESSAGE_SOURCE_TABLE,
            "domain",
            "destination_tx_id",
        )
        .await
    }

    async fn gas_payment_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<OutboxSourceBatch> {
        self.source_outbox_rows(
            domain,
            safe_position,
            OUTBOX_GAS_PAYMENT_EVENT_TYPE,
            GAS_PAYMENT_SOURCE_TABLE,
            "domain",
            "tx_id",
        )
        .await
    }

    async fn merkle_tree_insertion_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<OutboxSourceBatch> {
        self.source_outbox_rows(
            domain,
            safe_position,
            OUTBOX_MERKLE_TREE_INSERTION_EVENT_TYPE,
            MERKLE_TREE_INSERTION_SOURCE_TABLE,
            "domain",
            "origin_tx_id",
        )
        .await
    }
}

fn outbox_conflict_clause() -> OnConflict {
    OnConflict::columns([
        outbox::Column::Domain,
        outbox::Column::EventType,
        outbox::Column::SourceId,
    ])
    .do_nothing()
    .to_owned()
}

fn outbox_insert_chunks<T>(rows: &[T]) -> std::slice::Chunks<'_, T> {
    rows.chunks(OUTBOX_INSERT_ROW_CHUNK)
}

fn outbox_model(
    domain: u32,
    position: i64,
    event_type: &str,
    source_table: &str,
    source_id: i64,
) -> outbox::ActiveModel {
    outbox::ActiveModel {
        id: NotSet,
        domain: Set(domain as i32),
        position: Set(position),
        event_type: Set(event_type.to_owned()),
        source_table: Set(source_table.to_owned()),
        source_id: Set(source_id),
        time_created: Set(date_time::now()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use migration::MigratorTrait;
    use sea_orm::{Database, DbErr};
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;

    #[test]
    fn chunks_batches_above_postgres_parameter_limit() {
        let rows = vec![(); 10_923];
        let chunk_lengths = outbox_insert_chunks(&rows)
            .map(|chunk| chunk.len())
            .collect::<Vec<_>>();

        assert_eq!(chunk_lengths, vec![5_000, 5_000, 923]);
    }

    #[test]
    fn source_batch_requires_an_exhaustion_probe() {
        let rows = (0..=OUTBOX_SOURCE_ROW_CHUNK)
            .map(|id| OutboxSourceRow {
                id: id as i64,
                position: 10,
            })
            .collect();

        let batch = OutboxSourceBatch::from_rows(rows);

        assert_eq!(batch.rows.len(), OUTBOX_SOURCE_ROW_CHUNK as usize);
        assert!(!batch.exhausted);
    }

    #[tokio::test]
    async fn test_outbox_exhaustion_and_reversed_commit_order_real_postgres() -> Result<(), DbErr> {
        let postgres_container = Postgres::default()
            .start()
            .await
            .expect("Postgres test container should start");
        let host_port = postgres_container
            .get_host_port_ipv4(5432)
            .await
            .expect("Postgres test port should be available");
        let postgres_url = format!("postgresql://postgres:postgres@127.0.0.1:{host_port}/postgres");
        let db = Database::connect(&postgres_url).await?;
        migration::Migrator::up(&db, Some(11)).await?;
        db.execute_unprepared(
            r#"
            INSERT INTO cursor (domain, time_created, height, event_type)
            VALUES (1, NOW(), 9, 'hyperlane_message')
            "#,
        )
        .await?;
        migration::Migrator::up(&db, None).await?;
        let bootstrapped_height: i64 = db
            .query_one(Statement::from_string(
                db.get_database_backend(),
                "SELECT height FROM indexing_checkpoint WHERE domain = 1 AND event_type = 'hyperlane_message'",
            ))
            .await?
            .expect("bootstrapped checkpoint should exist")
            .try_get("", "height")?;
        assert_eq!(bootstrapped_height, 9);
        db.execute_unprepared(
            r#"
            INSERT INTO block (domain, hash, height, timestamp)
            VALUES (1, decode(repeat('01', 32), 'hex'), 10, NOW());
            INSERT INTO "transaction"
                (hash, block_id, gas_limit, nonce, sender, gas_used, cumulative_gas_used)
            VALUES
                (decode(repeat('02', 32), 'hex'), 1, 1, 1,
                 decode(repeat('03', 32), 'hex'), 1, 1);
            INSERT INTO indexing_checkpoint
                (domain, event_type, height, time_created, time_updated)
            VALUES
                (1, 'hyperlane_message_outbox', 10, NOW(), NOW()),
                (1, 'delivery_outbox', 10, NOW(), NOW()),
                (1, 'interchain_gas_payment_outbox', 10, NOW(), NOW()),
                (1, 'merkle_tree_insertion_outbox', 10, NOW(), NOW());
            INSERT INTO message
                (msg_id, origin, destination, nonce, sender, recipient,
                 origin_mailbox, origin_tx_id)
            SELECT
                decode(lpad(to_hex(value), 64, '0'), 'hex'), 1, 2, value,
                decode(repeat('04', 32), 'hex'), decode(repeat('05', 32), 'hex'),
                decode(repeat('06', 32), 'hex'), 1
            FROM generate_series(1, 5001) AS value;
            "#,
        )
        .await?;

        let scraper_db = ScraperDb::with_connection(Database::connect(&postgres_url).await?);
        scraper_db
            .build_outbox(1)
            .await
            .expect("first outbox pass should succeed");
        let checkpoint_count: i64 = db
            .query_one(Statement::from_string(
                db.get_database_backend(),
                "SELECT COUNT(*) AS count FROM outbox WHERE event_type = 'indexing_checkpoint'",
            ))
            .await?
            .expect("checkpoint count query should return a row")
            .try_get("", "count")?;
        assert_eq!(checkpoint_count, 0);

        scraper_db
            .build_outbox(1)
            .await
            .expect("second outbox pass should succeed");
        let outbox_count: i64 = db
            .query_one(Statement::from_string(
                db.get_database_backend(),
                "SELECT COUNT(*) AS count FROM outbox",
            ))
            .await?
            .expect("outbox count query should return a row")
            .try_get("", "count")?;
        assert_eq!(outbox_count, 5_002);

        db.execute_unprepared("TRUNCATE outbox, message RESTART IDENTITY")
            .await?;
        let first = db.begin().await?;
        first
            .execute_unprepared(
                r#"
                INSERT INTO message
                    (msg_id, origin, destination, nonce, sender, recipient,
                     origin_mailbox, origin_tx_id)
                VALUES
                    (decode(repeat('07', 32), 'hex'), 1, 2, 1,
                     decode(repeat('04', 32), 'hex'), decode(repeat('05', 32), 'hex'),
                     decode(repeat('06', 32), 'hex'), 1)
                "#,
            )
            .await?;
        let second = db.begin().await?;
        second
            .execute_unprepared(
                r#"
                INSERT INTO message
                    (msg_id, origin, destination, nonce, sender, recipient,
                     origin_mailbox, origin_tx_id)
                VALUES
                    (decode(repeat('08', 32), 'hex'), 1, 2, 2,
                     decode(repeat('04', 32), 'hex'), decode(repeat('05', 32), 'hex'),
                     decode(repeat('06', 32), 'hex'), 1)
                "#,
            )
            .await?;
        second.commit().await?;

        scraper_db
            .build_outbox(1)
            .await
            .expect("outbox pass before the lower ID commits should succeed");
        first.commit().await?;
        scraper_db
            .build_outbox(1)
            .await
            .expect("outbox pass after the lower ID commits should succeed");

        let source_ids = outbox::Entity::find()
            .filter(outbox::Column::EventType.eq(OUTBOX_MESSAGE_EVENT_TYPE))
            .order_by_asc(outbox::Column::SourceId)
            .select_only()
            .column(outbox::Column::SourceId)
            .into_tuple::<i64>()
            .all(&db)
            .await?;
        assert_eq!(source_ids, vec![1, 2]);

        Ok(())
    }
}
