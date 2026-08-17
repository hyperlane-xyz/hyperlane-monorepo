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
const MESSAGE_CURSOR_EVENT_TYPE: &str = "hyperlane_message";
const DELIVERY_CURSOR_EVENT_TYPE: &str = "delivery";
const GAS_PAYMENT_CURSOR_EVENT_TYPE: &str = "interchain_gas_payment";
const MERKLE_TREE_INSERTION_CURSOR_EVENT_TYPE: &str = "merkle_tree_insertion";
const REQUIRED_INDEXING_CHECKPOINT_COUNT: usize = 4;
const OUTBOX_BUILD_BLOCK_CHUNK: i64 = 10_000;

#[derive(Clone, Debug, FromQueryResult)]
struct OutboxSourceRow {
    id: i64,
    position: i64,
}

impl ScraperDb {
    /// Build outbox rows up to the current safe indexed position for a domain.
    ///
    /// If no outbox indexing checkpoint exists yet, this starts from position 0 and
    /// backfills all currently indexed rows through the safe position.
    #[instrument(skip(self))]
    pub async fn build_outbox(&self, domain: u32) -> Result<u64> {
        let Some(safe_position) = self.safe_outbox_position(domain).await? else {
            return Ok(0);
        };
        let last_position = self.last_outbox_position(domain).await?;
        if safe_position <= last_position {
            return Ok(0);
        }
        let target_position =
            safe_position.min(last_position.saturating_add(OUTBOX_BUILD_BLOCK_CHUNK));

        let messages = self
            .message_outbox_rows(domain, last_position, target_position)
            .await?;
        let deliveries = self
            .delivery_outbox_rows(domain, last_position, target_position)
            .await?;
        let gas_payments = self
            .gas_payment_outbox_rows(domain, last_position, target_position)
            .await?;
        let merkle_tree_insertions = self
            .merkle_tree_insertion_outbox_rows(domain, last_position, target_position)
            .await?;

        let mut models = Vec::with_capacity(
            messages.len()
                + deliveries.len()
                + gas_payments.len()
                + merkle_tree_insertions.len()
                + usize::from(true),
        );
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
        models.push(outbox_model(
            domain,
            target_position,
            OUTBOX_INDEXING_CHECKPOINT_EVENT_TYPE,
            INDEXING_CHECKPOINT_SOURCE_TABLE,
            target_position,
        ));

        let txn = self.0.begin().await?;
        let inserted = models.len() as u64;
        outbox::Entity::insert_many(models)
            .on_conflict(
                OnConflict::columns([
                    outbox::Column::Domain,
                    outbox::Column::EventType,
                    outbox::Column::SourceId,
                ])
                .do_nothing()
                .to_owned(),
            )
            .exec(&txn)
            .await?;
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

    async fn last_outbox_position(&self, domain: u32) -> Result<i64> {
        let position = outbox::Entity::find()
            .filter(outbox::Column::Domain.eq(domain))
            .filter(outbox::Column::EventType.eq(OUTBOX_INDEXING_CHECKPOINT_EVENT_TYPE))
            .order_by(outbox::Column::Position, Order::Desc)
            .select_only()
            .column(outbox::Column::Position)
            .into_tuple::<i64>()
            .one(&self.0)
            .await?
            .unwrap_or(0);
        Ok(position)
    }

    async fn message_outbox_rows(
        &self,
        domain: u32,
        last_position: i64,
        safe_position: i64,
    ) -> Result<Vec<OutboxSourceRow>> {
        Ok(message::Entity::find()
            .select_only()
            .column_as(message::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .join(JoinType::InnerJoin, message::Relation::Transaction.def())
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(message::Column::Origin.eq(domain))
            .filter(block::Column::Height.gt(last_position))
            .filter(block::Column::Height.lte(safe_position))
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?)
    }

    async fn delivery_outbox_rows(
        &self,
        domain: u32,
        last_position: i64,
        safe_position: i64,
    ) -> Result<Vec<OutboxSourceRow>> {
        Ok(delivered_message::Entity::find()
            .select_only()
            .column_as(delivered_message::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .join(
                JoinType::InnerJoin,
                delivered_message::Relation::Transaction.def(),
            )
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(delivered_message::Column::Domain.eq(domain))
            .filter(block::Column::Height.gt(last_position))
            .filter(block::Column::Height.lte(safe_position))
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?)
    }

    async fn gas_payment_outbox_rows(
        &self,
        domain: u32,
        last_position: i64,
        safe_position: i64,
    ) -> Result<Vec<OutboxSourceRow>> {
        Ok(gas_payment::Entity::find()
            .select_only()
            .column_as(gas_payment::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .join(
                JoinType::InnerJoin,
                gas_payment::Relation::Transaction.def(),
            )
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(gas_payment::Column::Domain.eq(domain))
            .filter(block::Column::Height.gt(last_position))
            .filter(block::Column::Height.lte(safe_position))
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?)
    }

    async fn merkle_tree_insertion_outbox_rows(
        &self,
        domain: u32,
        last_position: i64,
        safe_position: i64,
    ) -> Result<Vec<OutboxSourceRow>> {
        Ok(merkle_tree_insertion::Entity::find()
            .select_only()
            .column_as(merkle_tree_insertion::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .join(
                JoinType::InnerJoin,
                merkle_tree_insertion::Relation::Transaction.def(),
            )
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(merkle_tree_insertion::Column::Domain.eq(domain))
            .filter(block::Column::Height.gt(last_position))
            .filter(block::Column::Height.lte(safe_position))
            .into_model::<OutboxSourceRow>()
            .all(&self.0)
            .await?)
    }
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
