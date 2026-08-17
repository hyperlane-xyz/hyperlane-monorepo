use eyre::Result;
use migration::OnConflict;
use sea_orm::FromQueryResult;
use sea_orm::{
    prelude::*, ActiveValue::*, ColumnTrait, EntityTrait, JoinType, Order, QueryFilter, QueryOrder,
    QuerySelect, RelationTrait, TransactionTrait,
};
use serde_json::json;
use tracing::{debug, instrument};

use hyperlane_core::utils::bytes_to_hex;

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
const MESSAGE_CURSOR_EVENT_TYPE: &str = "hyperlane_message";
const DELIVERY_CURSOR_EVENT_TYPE: &str = "delivery";
const GAS_PAYMENT_CURSOR_EVENT_TYPE: &str = "interchain_gas_payment";
const MERKLE_TREE_INSERTION_CURSOR_EVENT_TYPE: &str = "merkle_tree_insertion";
const REQUIRED_INDEXING_CHECKPOINT_COUNT: usize = 4;

#[derive(Clone, Debug, FromQueryResult)]
struct MessageOutboxRow {
    id: i64,
    position: i64,
    msg_id: Vec<u8>,
    origin: i32,
    destination: i32,
    nonce: i32,
    sender: Vec<u8>,
    recipient: Vec<u8>,
    msg_body: Option<Vec<u8>>,
    origin_mailbox: Vec<u8>,
    origin_tx_id: i64,
}

#[derive(Clone, Debug, FromQueryResult)]
struct DeliveryOutboxRow {
    id: i64,
    position: i64,
    msg_id: Vec<u8>,
    domain: i32,
    destination_mailbox: Vec<u8>,
    destination_tx_id: i64,
    sequence: Option<i64>,
}

#[derive(Clone, Debug, FromQueryResult)]
struct GasPaymentOutboxRow {
    id: i64,
    position: i64,
    domain: i32,
    msg_id: Vec<u8>,
    payment: BigDecimal,
    gas_amount: BigDecimal,
    tx_id: i64,
    log_index: i64,
    origin: i32,
    destination: i32,
    interchain_gas_paymaster: Vec<u8>,
    sequence: Option<i64>,
}

#[derive(Clone, Debug, FromQueryResult)]
struct MerkleTreeInsertionOutboxRow {
    id: i64,
    position: i64,
    domain: i32,
    merkle_tree_hook: Vec<u8>,
    leaf_index: i32,
    message_id: Vec<u8>,
    origin_tx_id: i64,
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

        let messages = self
            .message_outbox_rows(domain, last_position, safe_position)
            .await?;
        let deliveries = self
            .delivery_outbox_rows(domain, last_position, safe_position)
            .await?;
        let gas_payments = self
            .gas_payment_outbox_rows(domain, last_position, safe_position)
            .await?;
        let merkle_tree_insertions = self
            .merkle_tree_insertion_outbox_rows(domain, last_position, safe_position)
            .await?;

        let mut models = Vec::with_capacity(
            messages.len()
                + deliveries.len()
                + gas_payments.len()
                + merkle_tree_insertions.len()
                + usize::from(true),
        );
        for row in messages {
            models.push(outbox::ActiveModel {
                id: NotSet,
                domain: Set(domain as i32),
                position: Set(row.position),
                event_type: Set(OUTBOX_MESSAGE_EVENT_TYPE.to_owned()),
                source_id: Set(row.id),
                payload: Set(json!({
                    "type": OUTBOX_MESSAGE_EVENT_TYPE,
                    "id": row.id,
                    "position": row.position,
                    "msgId": bytes_to_hex(&row.msg_id),
                    "origin": row.origin,
                    "destination": row.destination,
                    "nonce": row.nonce,
                    "sender": bytes_to_hex(&row.sender),
                    "recipient": bytes_to_hex(&row.recipient),
                    "body": row.msg_body.as_deref().map(bytes_to_hex),
                    "originMailbox": bytes_to_hex(&row.origin_mailbox),
                    "originTxId": row.origin_tx_id,
                })),
                time_created: Set(date_time::now()),
            });
        }
        for row in deliveries {
            models.push(outbox::ActiveModel {
                id: NotSet,
                domain: Set(domain as i32),
                position: Set(row.position),
                event_type: Set(OUTBOX_DELIVERY_EVENT_TYPE.to_owned()),
                source_id: Set(row.id),
                payload: Set(json!({
                    "type": OUTBOX_DELIVERY_EVENT_TYPE,
                    "id": row.id,
                    "position": row.position,
                    "msgId": bytes_to_hex(&row.msg_id),
                    "domain": row.domain,
                    "destinationMailbox": bytes_to_hex(&row.destination_mailbox),
                    "destinationTxId": row.destination_tx_id,
                    "sequence": row.sequence,
                })),
                time_created: Set(date_time::now()),
            });
        }
        for row in gas_payments {
            models.push(outbox::ActiveModel {
                id: NotSet,
                domain: Set(domain as i32),
                position: Set(row.position),
                event_type: Set(OUTBOX_GAS_PAYMENT_EVENT_TYPE.to_owned()),
                source_id: Set(row.id),
                payload: Set(json!({
                    "type": OUTBOX_GAS_PAYMENT_EVENT_TYPE,
                    "id": row.id,
                    "position": row.position,
                    "domain": row.domain,
                    "msgId": bytes_to_hex(&row.msg_id),
                    "payment": row.payment.to_string(),
                    "gasAmount": row.gas_amount.to_string(),
                    "txId": row.tx_id,
                    "logIndex": row.log_index,
                    "origin": row.origin,
                    "destination": row.destination,
                    "interchainGasPaymaster": bytes_to_hex(&row.interchain_gas_paymaster),
                    "sequence": row.sequence,
                })),
                time_created: Set(date_time::now()),
            });
        }
        for row in merkle_tree_insertions {
            models.push(outbox::ActiveModel {
                id: NotSet,
                domain: Set(domain as i32),
                position: Set(row.position),
                event_type: Set(OUTBOX_MERKLE_TREE_INSERTION_EVENT_TYPE.to_owned()),
                source_id: Set(row.id),
                payload: Set(json!({
                    "type": OUTBOX_MERKLE_TREE_INSERTION_EVENT_TYPE,
                    "id": row.id,
                    "position": row.position,
                    "domain": row.domain,
                    "merkleTreeHook": bytes_to_hex(&row.merkle_tree_hook),
                    "leafIndex": row.leaf_index,
                    "messageId": bytes_to_hex(&row.message_id),
                    "originTxId": row.origin_tx_id,
                })),
                time_created: Set(date_time::now()),
            });
        }
        models.push(outbox::ActiveModel {
            id: NotSet,
            domain: Set(domain as i32),
            position: Set(safe_position),
            event_type: Set(OUTBOX_INDEXING_CHECKPOINT_EVENT_TYPE.to_owned()),
            source_id: Set(safe_position),
            payload: Set(json!({
                "type": OUTBOX_INDEXING_CHECKPOINT_EVENT_TYPE,
                "position": safe_position,
            })),
            time_created: Set(date_time::now()),
        });

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
            safe_position, last_position, inserted, "Built outbox"
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
    ) -> Result<Vec<MessageOutboxRow>> {
        Ok(message::Entity::find()
            .select_only()
            .column_as(message::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .column_as(message::Column::MsgId, "msg_id")
            .column(message::Column::Origin)
            .column(message::Column::Destination)
            .column(message::Column::Nonce)
            .column(message::Column::Sender)
            .column(message::Column::Recipient)
            .column(message::Column::MsgBody)
            .column(message::Column::OriginMailbox)
            .column(message::Column::OriginTxId)
            .join(JoinType::InnerJoin, message::Relation::Transaction.def())
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(message::Column::Origin.eq(domain))
            .filter(block::Column::Height.gt(last_position))
            .filter(block::Column::Height.lte(safe_position))
            .into_model::<MessageOutboxRow>()
            .all(&self.0)
            .await?)
    }

    async fn delivery_outbox_rows(
        &self,
        domain: u32,
        last_position: i64,
        safe_position: i64,
    ) -> Result<Vec<DeliveryOutboxRow>> {
        Ok(delivered_message::Entity::find()
            .select_only()
            .column_as(delivered_message::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .column_as(delivered_message::Column::MsgId, "msg_id")
            .column(delivered_message::Column::Domain)
            .column(delivered_message::Column::DestinationMailbox)
            .column(delivered_message::Column::DestinationTxId)
            .column(delivered_message::Column::Sequence)
            .join(
                JoinType::InnerJoin,
                delivered_message::Relation::Transaction.def(),
            )
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(delivered_message::Column::Domain.eq(domain))
            .filter(block::Column::Height.gt(last_position))
            .filter(block::Column::Height.lte(safe_position))
            .into_model::<DeliveryOutboxRow>()
            .all(&self.0)
            .await?)
    }

    async fn gas_payment_outbox_rows(
        &self,
        domain: u32,
        last_position: i64,
        safe_position: i64,
    ) -> Result<Vec<GasPaymentOutboxRow>> {
        Ok(gas_payment::Entity::find()
            .select_only()
            .column_as(gas_payment::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .column(gas_payment::Column::Domain)
            .column_as(gas_payment::Column::MsgId, "msg_id")
            .column(gas_payment::Column::Payment)
            .column(gas_payment::Column::GasAmount)
            .column(gas_payment::Column::TxId)
            .column(gas_payment::Column::LogIndex)
            .column(gas_payment::Column::Origin)
            .column(gas_payment::Column::Destination)
            .column(gas_payment::Column::InterchainGasPaymaster)
            .column(gas_payment::Column::Sequence)
            .join(
                JoinType::InnerJoin,
                gas_payment::Relation::Transaction.def(),
            )
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(gas_payment::Column::Domain.eq(domain))
            .filter(block::Column::Height.gt(last_position))
            .filter(block::Column::Height.lte(safe_position))
            .into_model::<GasPaymentOutboxRow>()
            .all(&self.0)
            .await?)
    }

    async fn merkle_tree_insertion_outbox_rows(
        &self,
        domain: u32,
        last_position: i64,
        safe_position: i64,
    ) -> Result<Vec<MerkleTreeInsertionOutboxRow>> {
        Ok(merkle_tree_insertion::Entity::find()
            .select_only()
            .column_as(merkle_tree_insertion::Column::Id, "id")
            .column_as(block::Column::Height, "position")
            .column(merkle_tree_insertion::Column::Domain)
            .column(merkle_tree_insertion::Column::MerkleTreeHook)
            .column(merkle_tree_insertion::Column::LeafIndex)
            .column(merkle_tree_insertion::Column::MessageId)
            .column(merkle_tree_insertion::Column::OriginTxId)
            .join(
                JoinType::InnerJoin,
                merkle_tree_insertion::Relation::Transaction.def(),
            )
            .join(JoinType::InnerJoin, transaction::Relation::Block.def())
            .filter(merkle_tree_insertion::Column::Domain.eq(domain))
            .filter(block::Column::Height.gt(last_position))
            .filter(block::Column::Height.lte(safe_position))
            .into_model::<MerkleTreeInsertionOutboxRow>()
            .all(&self.0)
            .await?)
    }
}
