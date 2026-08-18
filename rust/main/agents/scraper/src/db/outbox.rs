use eyre::Result;
use migration::OnConflict;
use sea_orm::sea_query::{Alias, Cond, Expr, Func, Query};
use sea_orm::FromQueryResult;
use sea_orm::{
    ActiveValue::*, ColumnTrait, ConnectionTrait, DatabaseTransaction, DbBackend, EntityTrait,
    JoinType, Order, QueryFilter, QueryOrder, QuerySelect, RelationTrait, TransactionTrait,
};
use tracing::{debug, instrument};

use crate::date_time;
use crate::db::ScraperDb;

use super::generated::{
    block, delivered_message, gas_payment, indexing_checkpoint, merkle_tree_insertion, message,
    outbox, raw_message_dispatch, transaction,
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
pub(crate) const CCR_CURSOR_EVENT_TYPE: &str = "ccr_swap_outbox";
const REQUIRED_INDEXING_CHECKPOINT_COUNT: usize = 4;
const OUTBOX_BUILD_BLOCK_CHUNK: i64 = 10_000;
const OUTBOX_INSERT_ROW_CHUNK: usize = 5_000;
const OUTBOX_LOCK_KEY: i64 = 1_559_648_230;
const OUTBOX_LOCK_NAMESPACE: i32 = 1_559_648_230;

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
    /// Source pointers identify rows; later source-row updates are not separate
    /// outbox events.
    #[instrument(skip(self))]
    pub async fn build_outbox(&self, domain: u32, require_ccr: bool) -> Result<u64> {
        let txn = self.0.begin().await?;
        Self::lock_outbox_domain(&txn, domain).await?;

        let Some(mut safe_position) = self.safe_outbox_position(&txn, domain, require_ccr).await?
        else {
            txn.commit().await?;
            return Ok(0);
        };
        let Some(last_position) = self.last_outbox_position(&txn, domain).await? else {
            txn.commit().await?;
            return Ok(0);
        };
        if safe_position <= last_position {
            txn.commit().await?;
            return Ok(0);
        }
        if let Some(position) = self
            .first_unreconciled_raw_dispatch_position(&txn, domain)
            .await?
        {
            safe_position = safe_position.min(position.saturating_sub(1));
        }
        if safe_position <= last_position {
            txn.commit().await?;
            return Ok(0);
        }
        let target_position =
            safe_position.min(last_position.saturating_add(OUTBOX_BUILD_BLOCK_CHUNK));

        let messages = self
            .message_outbox_rows(&txn, domain, last_position, target_position)
            .await?;
        let deliveries = self
            .delivery_outbox_rows(&txn, domain, last_position, target_position)
            .await?;
        let gas_payments = self
            .gas_payment_outbox_rows(&txn, domain, last_position, target_position)
            .await?;
        let merkle_tree_insertions = self
            .merkle_tree_insertion_outbox_rows(&txn, domain, last_position, target_position)
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

        let inserted = models.len() as u64;
        Self::lock_outbox(&txn).await?;
        for chunk in models.chunks(OUTBOX_INSERT_ROW_CHUNK) {
            outbox::Entity::insert_many(chunk.iter().cloned())
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

    async fn lock_outbox(connection: &DatabaseTransaction) -> Result<()> {
        let query = Query::select()
            .expr(Func::cust(Alias::new("pg_advisory_xact_lock")).arg(OUTBOX_LOCK_KEY))
            .to_owned();
        connection
            .query_one(DbBackend::Postgres.build(&query))
            .await?;
        Ok(())
    }

    async fn lock_outbox_domain(connection: &DatabaseTransaction, domain: u32) -> Result<()> {
        let query = Query::select()
            .expr(
                Func::cust(Alias::new("pg_advisory_xact_lock"))
                    .arg(OUTBOX_LOCK_NAMESPACE)
                    .arg(domain as i32),
            )
            .to_owned();
        connection
            .query_one(DbBackend::Postgres.build(&query))
            .await?;
        Ok(())
    }

    async fn safe_outbox_position(
        &self,
        connection: &DatabaseTransaction,
        domain: u32,
        require_ccr: bool,
    ) -> Result<Option<i64>> {
        let mut event_types = vec![
            MESSAGE_CURSOR_EVENT_TYPE,
            DELIVERY_CURSOR_EVENT_TYPE,
            GAS_PAYMENT_CURSOR_EVENT_TYPE,
            MERKLE_TREE_INSERTION_CURSOR_EVENT_TYPE,
        ];
        if require_ccr {
            event_types.push(CCR_CURSOR_EVENT_TYPE);
        }
        let heights = indexing_checkpoint::Entity::find()
            .filter(indexing_checkpoint::Column::Domain.eq(domain))
            .filter(indexing_checkpoint::Column::EventType.is_in(event_types))
            .select_only()
            .column(indexing_checkpoint::Column::Height)
            .into_tuple::<i64>()
            .all(connection)
            .await?;

        if heights.len() < REQUIRED_INDEXING_CHECKPOINT_COUNT + usize::from(require_ccr) {
            return Ok(None);
        }

        Ok(heights.into_iter().min())
    }

    async fn last_outbox_position(
        &self,
        connection: &DatabaseTransaction,
        domain: u32,
    ) -> Result<Option<i64>> {
        if let Some(position) = outbox::Entity::find()
            .filter(outbox::Column::Domain.eq(domain))
            .filter(outbox::Column::EventType.eq(OUTBOX_INDEXING_CHECKPOINT_EVENT_TYPE))
            .order_by(outbox::Column::Position, Order::Desc)
            .select_only()
            .column(outbox::Column::Position)
            .into_tuple::<i64>()
            .one(connection)
            .await?
        {
            return Ok(Some(position));
        }

        Ok(self
            .first_indexed_block(connection, domain)
            .await?
            .map(|height| height.saturating_sub(1)))
    }

    async fn first_indexed_block(
        &self,
        connection: &DatabaseTransaction,
        domain: u32,
    ) -> Result<Option<i64>> {
        Ok(block::Entity::find()
            .filter(block::Column::Domain.eq(domain))
            .select_only()
            .column_as(block::Column::Height.min(), "height")
            .into_tuple::<Option<i64>>()
            .one(connection)
            .await?
            .flatten())
    }

    async fn first_unreconciled_raw_dispatch_position(
        &self,
        connection: &DatabaseTransaction,
        domain: u32,
    ) -> Result<Option<i64>> {
        let missing_message = Cond::all().not().add(Expr::exists(
            Query::select()
                .expr(Expr::val(1))
                .from(message::Entity)
                .and_where(
                    Expr::col((message::Entity, message::Column::MsgId)).equals((
                        raw_message_dispatch::Entity,
                        raw_message_dispatch::Column::MsgId,
                    )),
                )
                .to_owned(),
        ));
        Ok(raw_message_dispatch::Entity::find()
            .filter(raw_message_dispatch::Column::OriginDomain.eq(domain))
            .filter(raw_message_dispatch::Column::MsgBody.is_not_null())
            .filter(missing_message)
            .select_only()
            .column_as(
                raw_message_dispatch::Column::OriginBlockHeight.min(),
                "height",
            )
            .into_tuple::<Option<i64>>()
            .one(connection)
            .await?
            .flatten())
    }

    async fn message_outbox_rows(
        &self,
        connection: &DatabaseTransaction,
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
            .all(connection)
            .await?)
    }

    async fn delivery_outbox_rows(
        &self,
        connection: &DatabaseTransaction,
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
            .all(connection)
            .await?)
    }

    async fn gas_payment_outbox_rows(
        &self,
        connection: &DatabaseTransaction,
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
            .all(connection)
            .await?)
    }

    async fn merkle_tree_insertion_outbox_rows(
        &self,
        connection: &DatabaseTransaction,
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
            .all(connection)
            .await?)
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
