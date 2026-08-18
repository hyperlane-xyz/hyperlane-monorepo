use eyre::Result;
use migration::OnConflict;
use sea_orm::FromQueryResult;
use sea_orm::{
    ActiveValue::*, ColumnTrait, EntityTrait, JoinType, Order, QueryFilter, QueryOrder,
    QuerySelect, RelationTrait, TransactionTrait,
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

        let capacity = messages
            .len()
            .saturating_add(deliveries.len())
            .saturating_add(gas_payments.len())
            .saturating_add(merkle_tree_insertions.len());
        let mut models = Vec::with_capacity(capacity);
        for row in messages {
            models.push(outbox_model(
                domain,
                row.position,
                OUTBOX_MESSAGE_EVENT_TYPE,
                MESSAGE_SOURCE_TABLE,
                row.id,
            ));
        }
        for row in deliveries {
            models.push(outbox_model(
                domain,
                row.position,
                OUTBOX_DELIVERY_EVENT_TYPE,
                DELIVERED_MESSAGE_SOURCE_TABLE,
                row.id,
            ));
        }
        for row in gas_payments {
            models.push(outbox_model(
                domain,
                row.position,
                OUTBOX_GAS_PAYMENT_EVENT_TYPE,
                GAS_PAYMENT_SOURCE_TABLE,
                row.id,
            ));
        }
        for row in merkle_tree_insertions {
            models.push(outbox_model(
                domain,
                row.position,
                OUTBOX_MERKLE_TREE_INSERTION_EVENT_TYPE,
                MERKLE_TREE_INSERTION_SOURCE_TABLE,
                row.id,
            ));
        }
        let checkpoint = (target_position > last_position).then(|| {
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

    async fn last_outbox_source_id(
        &self,
        domain: u32,
        event_type: &str,
        source_table: &str,
    ) -> Result<i64> {
        Ok(outbox::Entity::find()
            .filter(outbox::Column::Domain.eq(domain))
            .filter(outbox::Column::EventType.eq(event_type))
            .filter(outbox::Column::SourceTable.eq(source_table))
            .select_only()
            .column_as(outbox::Column::SourceId.max(), "max_id")
            .into_tuple::<Option<i64>>()
            .one(&self.0)
            .await?
            .flatten()
            .unwrap_or_default())
    }

    async fn message_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<Vec<OutboxSourceRow>> {
        let last_source_id = self
            .last_outbox_source_id(domain, OUTBOX_MESSAGE_EVENT_TYPE, MESSAGE_SOURCE_TABLE)
            .await?;
        let rows = message::Entity::find()
            .select_only()
            .column_as(message::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .join(JoinType::InnerJoin, message::Relation::Transaction.def())
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(message::Column::Origin.eq(domain))
            .filter(message::Column::Id.gt(last_source_id))
            .order_by_asc(message::Column::Id)
            .limit(OUTBOX_SOURCE_ROW_CHUNK)
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?;
        Ok(rows_up_to_safe_position(rows, safe_position))
    }

    async fn delivery_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<Vec<OutboxSourceRow>> {
        let last_source_id = self
            .last_outbox_source_id(
                domain,
                OUTBOX_DELIVERY_EVENT_TYPE,
                DELIVERED_MESSAGE_SOURCE_TABLE,
            )
            .await?;
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
            .filter(delivered_message::Column::Id.gt(last_source_id))
            .order_by_asc(delivered_message::Column::Id)
            .limit(OUTBOX_SOURCE_ROW_CHUNK)
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?;
        Ok(rows_up_to_safe_position(rows, safe_position))
    }

    async fn gas_payment_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<Vec<OutboxSourceRow>> {
        let last_source_id = self
            .last_outbox_source_id(
                domain,
                OUTBOX_GAS_PAYMENT_EVENT_TYPE,
                GAS_PAYMENT_SOURCE_TABLE,
            )
            .await?;
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
            .filter(gas_payment::Column::Id.gt(last_source_id))
            .order_by_asc(gas_payment::Column::Id)
            .limit(OUTBOX_SOURCE_ROW_CHUNK)
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?;
        Ok(rows_up_to_safe_position(rows, safe_position))
    }

    async fn merkle_tree_insertion_outbox_rows(
        &self,
        domain: u32,
        safe_position: i64,
    ) -> Result<Vec<OutboxSourceRow>> {
        let last_source_id = self
            .last_outbox_source_id(
                domain,
                OUTBOX_MERKLE_TREE_INSERTION_EVENT_TYPE,
                MERKLE_TREE_INSERTION_SOURCE_TABLE,
            )
            .await?;
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
            .filter(merkle_tree_insertion::Column::Id.gt(last_source_id))
            .order_by_asc(merkle_tree_insertion::Column::Id)
            .limit(OUTBOX_SOURCE_ROW_CHUNK)
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?;
        Ok(rows_up_to_safe_position(rows, safe_position))
    }
}

fn rows_up_to_safe_position(
    rows: Vec<OutboxSourceRow>,
    safe_position: i64,
) -> Vec<OutboxSourceRow> {
    rows.into_iter()
        .take_while(|row| row.position <= safe_position)
        .collect()
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

    #[test]
    fn chunks_batches_above_postgres_parameter_limit() {
        let rows = vec![(); 10_923];
        let chunk_lengths = outbox_insert_chunks(&rows)
            .map(|chunk| chunk.len())
            .collect::<Vec<_>>();

        assert_eq!(chunk_lengths, vec![5_000, 5_000, 923]);
    }

    #[test]
    fn source_rows_stop_before_unsafe_id() {
        let rows = vec![
            OutboxSourceRow {
                id: 1,
                position: 10,
            },
            OutboxSourceRow {
                id: 2,
                position: 30,
            },
            OutboxSourceRow {
                id: 3,
                position: 20,
            },
        ];

        assert_eq!(
            rows_up_to_safe_position(rows, 20)
                .into_iter()
                .map(|row| row.id)
                .collect::<Vec<_>>(),
            vec![1]
        );
    }
}
