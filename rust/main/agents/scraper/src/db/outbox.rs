use eyre::Result;
use migration::OnConflict;
use sea_orm::sea_query::{Cond, Expr, Query, SimpleExpr};
use sea_orm::{
    ActiveValue::*, ColumnTrait, EntityTrait, FromQueryResult, JoinType, Order, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait, TransactionTrait,
};
use tracing::{debug, instrument};

use crate::date_time;
use crate::db::ScraperDb;

use super::generated::{
    block, delivered_message, gas_payment, indexing_checkpoint, merkle_tree_insertion, message,
    outbox, transaction,
};

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

    fn not_outboxed(domain: u32, event_type: &str, source_id: SimpleExpr) -> sea_orm::Condition {
        Cond::all().not().add(Expr::exists(
            Query::select()
                .expr(Expr::val(1))
                .from(outbox::Entity)
                .and_where(Expr::col(outbox::Column::Domain).eq(domain))
                .and_where(Expr::col(outbox::Column::EventType).eq(event_type))
                .and_where(Expr::col(outbox::Column::SourceId).eq(source_id))
                .to_owned(),
        ))
    }

    async fn message_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<OutboxSourceBatch> {
        let rows = message::Entity::find()
            .select_only()
            .column_as(message::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .join(JoinType::InnerJoin, message::Relation::Transaction.def())
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(message::Column::Origin.eq(domain))
            .filter(block::Column::Height.lte(safe_position))
            .filter(Self::not_outboxed(
                domain,
                OUTBOX_MESSAGE_EVENT_TYPE,
                Expr::col((message::Entity, message::Column::Id)).into(),
            ))
            .order_by_asc(message::Column::Id)
            .limit(OUTBOX_SOURCE_ROW_CHUNK.saturating_add(1))
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?;
        Ok(OutboxSourceBatch::from_rows(rows))
    }

    async fn delivery_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<OutboxSourceBatch> {
        let rows = delivered_message::Entity::find()
            .select_only()
            .column_as(delivered_message::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .join(
                JoinType::InnerJoin,
                delivered_message::Relation::Transaction.def(),
            )
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(delivered_message::Column::Domain.eq(domain))
            .filter(block::Column::Height.lte(safe_position))
            .filter(Self::not_outboxed(
                domain,
                OUTBOX_DELIVERY_EVENT_TYPE,
                Expr::col((delivered_message::Entity, delivered_message::Column::Id)).into(),
            ))
            .order_by_asc(delivered_message::Column::Id)
            .limit(OUTBOX_SOURCE_ROW_CHUNK.saturating_add(1))
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?;
        Ok(OutboxSourceBatch::from_rows(rows))
    }

    async fn gas_payment_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<OutboxSourceBatch> {
        let rows = gas_payment::Entity::find()
            .select_only()
            .column_as(gas_payment::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .join(
                JoinType::InnerJoin,
                gas_payment::Relation::Transaction.def(),
            )
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(gas_payment::Column::Domain.eq(domain))
            .filter(block::Column::Height.lte(safe_position))
            .filter(Self::not_outboxed(
                domain,
                OUTBOX_GAS_PAYMENT_EVENT_TYPE,
                Expr::col((gas_payment::Entity, gas_payment::Column::Id)).into(),
            ))
            .order_by_asc(gas_payment::Column::Id)
            .limit(OUTBOX_SOURCE_ROW_CHUNK.saturating_add(1))
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?;
        Ok(OutboxSourceBatch::from_rows(rows))
    }

    async fn merkle_tree_insertion_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<OutboxSourceBatch> {
        let rows = merkle_tree_insertion::Entity::find()
            .select_only()
            .column_as(merkle_tree_insertion::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .join(
                JoinType::InnerJoin,
                merkle_tree_insertion::Relation::Transaction.def(),
            )
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(merkle_tree_insertion::Column::Domain.eq(domain))
            .filter(block::Column::Height.lte(safe_position))
            .filter(Self::not_outboxed(
                domain,
                OUTBOX_MERKLE_TREE_INSERTION_EVENT_TYPE,
                Expr::col((
                    merkle_tree_insertion::Entity,
                    merkle_tree_insertion::Column::Id,
                ))
                .into(),
            ))
            .order_by_asc(merkle_tree_insertion::Column::Id)
            .limit(OUTBOX_SOURCE_ROW_CHUNK.saturating_add(1))
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?;
        Ok(OutboxSourceBatch::from_rows(rows))
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
    use crate::db::generated::cursor;
    use migration::MigratorTrait;
    use sea_orm::prelude::BigDecimal;
    use sea_orm::{ActiveModelTrait, Database, DbErr, PaginatorTrait};
    use testcontainers::runners::AsyncRunner;
    use testcontainers_modules::postgres::Postgres;

    fn test_message(nonce: i32, transaction_id: i64) -> message::ActiveModel {
        message::ActiveModel {
            id: NotSet,
            time_created: Set(date_time::now()),
            msg_id: Set(nonce.to_be_bytes().to_vec()),
            origin: Set(1),
            destination: Set(2),
            nonce: Set(nonce),
            sender: Set(vec![4; 32]),
            recipient: Set(vec![5; 32]),
            msg_body: Set(None),
            origin_mailbox: Set(vec![6; 32]),
            origin_tx_id: Set(transaction_id),
        }
    }

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
        cursor::ActiveModel {
            id: NotSet,
            domain: Set(1),
            time_created: Set(date_time::now()),
            height: Set(9),
            event_type: Set("hyperlane_message".to_owned()),
        }
        .insert(&db)
        .await?;
        migration::Migrator::up(&db, None).await?;
        let bootstrapped_height = indexing_checkpoint::Entity::find()
            .filter(indexing_checkpoint::Column::Domain.eq(1))
            .filter(indexing_checkpoint::Column::EventType.eq("hyperlane_message"))
            .one(&db)
            .await?
            .expect("bootstrapped checkpoint should exist")
            .height;
        assert_eq!(bootstrapped_height, 9);

        let block = block::ActiveModel {
            id: NotSet,
            time_created: Set(date_time::now()),
            domain: Set(1),
            hash: Set(vec![1; 32]),
            height: Set(10),
            timestamp: Set(date_time::now()),
        }
        .insert(&db)
        .await?;
        let source_transaction = transaction::ActiveModel {
            id: NotSet,
            time_created: Set(date_time::now()),
            hash: Set(vec![2; 32]),
            block_id: Set(block.id),
            gas_limit: Set(BigDecimal::from(1)),
            max_priority_fee_per_gas: Set(None),
            max_fee_per_gas: Set(None),
            gas_price: Set(None),
            effective_gas_price: Set(None),
            nonce: Set(1),
            sender: Set(vec![3; 32]),
            recipient: Set(None),
            gas_used: Set(BigDecimal::from(1)),
            cumulative_gas_used: Set(BigDecimal::from(1)),
            raw_input_data: Set(None),
        }
        .insert(&db)
        .await?;
        let checkpoint_time = date_time::now();
        indexing_checkpoint::Entity::insert_many(
            [
                MESSAGE_CURSOR_EVENT_TYPE,
                DELIVERY_CURSOR_EVENT_TYPE,
                GAS_PAYMENT_CURSOR_EVENT_TYPE,
                MERKLE_TREE_INSERTION_CURSOR_EVENT_TYPE,
            ]
            .map(|event_type| indexing_checkpoint::ActiveModel {
                id: NotSet,
                domain: Set(1),
                event_type: Set(event_type.to_owned()),
                height: Set(10),
                time_created: Set(checkpoint_time),
                time_updated: Set(checkpoint_time),
            }),
        )
        .exec(&db)
        .await?;
        message::Entity::insert_many(
            (1..=5_001).map(|nonce| test_message(nonce, source_transaction.id)),
        )
        .exec(&db)
        .await?;

        let scraper_db = ScraperDb::with_connection(Database::connect(&postgres_url).await?);
        scraper_db
            .build_outbox(1)
            .await
            .expect("first outbox pass should succeed");
        let checkpoint_count = outbox::Entity::find()
            .filter(outbox::Column::EventType.eq(OUTBOX_INDEXING_CHECKPOINT_EVENT_TYPE))
            .count(&db)
            .await?;
        assert_eq!(checkpoint_count, 0);

        scraper_db
            .build_outbox(1)
            .await
            .expect("second outbox pass should succeed");
        let outbox_count = outbox::Entity::find().count(&db).await?;
        assert_eq!(outbox_count, 5_002);

        outbox::Entity::delete_many().exec(&db).await?;
        message::Entity::delete_many().exec(&db).await?;
        let first = db.begin().await?;
        let first_message = test_message(1, source_transaction.id)
            .insert(&first)
            .await?;
        let second = db.begin().await?;
        let second_message = test_message(2, source_transaction.id)
            .insert(&second)
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
        assert_eq!(source_ids, vec![first_message.id, second_message.id]);

        Ok(())
    }
}
