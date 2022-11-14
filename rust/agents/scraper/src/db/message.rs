use ethers::prelude::H256;
use eyre::Result;
use sea_orm::{
    prelude::*, ActiveValue::*, DeriveColumn, EnumIter, Insert, QueryOrder, QuerySelect,
};
use tracing::{instrument, trace};

use abacus_core::{CommittedMessage, LogMeta};
use migration::OnConflict;

use crate::conversions::format_h256;
use crate::date_time;
use crate::db::ScraperDb;

use super::generated::{delivered_message, message};

#[derive(Debug, Clone)]
pub struct StorableDelivery<'a> {
    pub inbox: H256,
    pub message_hash: H256,
    pub meta: &'a LogMeta,
    /// The database id of the transaction the delivery event occurred in
    pub txn_id: i64,
}

pub struct StorableMessage<'a> {
    pub msg: CommittedMessage,
    pub meta: &'a LogMeta,
    /// The database id of the transaction the message was sent in
    pub txn_id: i64,
    pub timestamp: TimeDateTime,
}

impl ScraperDb {
    /// Get the highest message leaf index that is stored in the database.
    #[instrument(skip(self))]
    pub async fn last_message_leaf_index(
        &self,
        origin_domain: u32,
        outbox_addr: &H256,
    ) -> Result<Option<u32>> {
        #[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
        enum QueryAs {
            LeafIndex,
        }

        Ok(message::Entity::find()
            .filter(message::Column::Origin.eq(origin_domain))
            .filter(message::Column::OutboxAddress.eq(format_h256(outbox_addr)))
            .order_by_desc(message::Column::LeafIndex)
            .select_only()
            .column_as(message::Column::LeafIndex, QueryAs::LeafIndex)
            .into_values::<i32, QueryAs>()
            .one(&self.0)
            .await?
            .map(|idx| idx as u32))
    }

    /// Store deliveries from an inbox into the database (or update an existing one).
    #[instrument(skip_all)]
    pub async fn store_deliveries(
        &self,
        domain: u32,
        deliveries: impl Iterator<Item = StorableDelivery<'_>>,
    ) -> Result<()> {
        // we have a race condition where a message may not have been scraped yet even
        // though we have received news of delivery on this chain, so the
        // message IDs are looked up in a separate "thread".
        let models = deliveries
            .map(|delivery| delivered_message::ActiveModel {
                id: NotSet,
                time_created: Set(date_time::now()),
                hash: Unchanged(format_h256(&delivery.message_hash)),
                domain: Unchanged(domain as i32),
                inbox_address: Unchanged(format_h256(&delivery.inbox)),
                tx_id: Set(delivery.txn_id),
            })
            .collect::<Vec<_>>();

        debug_assert!(!models.is_empty());
        trace!(?models, "Writing delivered messages to database");

        Insert::many(models)
            .on_conflict(
                OnConflict::columns([delivered_message::Column::Hash])
                    .update_columns([
                        delivered_message::Column::TimeCreated,
                        delivered_message::Column::TxId,
                    ])
                    .to_owned(),
            )
            .exec(&self.0)
            .await?;
        Ok(())
    }

    /// Store messages from an outbox into the database (or update an existing one).
    #[instrument(skip_all)]
    pub async fn store_messages(
        &self,
        outbox_addr: &H256,
        messages: impl Iterator<Item = StorableMessage<'_>>,
    ) -> Result<()> {
        let models = messages
            .map(|storable| {
                Ok(message::ActiveModel {
                    id: NotSet,
                    time_created: Set(crate::date_time::now()),
                    hash: Unchanged(format_h256(&storable.msg.to_leaf())),
                    origin: Unchanged(storable.msg.message.origin as i32),
                    destination: Set(storable.msg.message.destination as i32),
                    leaf_index: Unchanged(storable.msg.leaf_index as i32),
                    sender: Set(format_h256(&storable.msg.message.sender)),
                    recipient: Set(format_h256(&storable.msg.message.recipient)),
                    msg_body: Set(if storable.msg.message.body.is_empty() {
                        None
                    } else {
                        Some(storable.msg.message.body)
                    }),
                    outbox_address: Unchanged(format_h256(outbox_addr)),
                    timestamp: Set(storable.timestamp),
                    origin_tx_id: Set(storable.txn_id),
                })
            })
            .collect::<Result<Vec<message::ActiveModel>>>()?;

        debug_assert!(!models.is_empty());
        trace!(?models, "Writing messages to database");

        Insert::many(models)
            .on_conflict(
                OnConflict::columns([
                    message::Column::OutboxAddress,
                    message::Column::Origin,
                    message::Column::LeafIndex,
                ])
                .update_columns([
                    message::Column::TimeCreated,
                    message::Column::Destination,
                    message::Column::Sender,
                    message::Column::Recipient,
                    message::Column::MsgBody,
                    message::Column::Timestamp,
                    message::Column::OriginTxId,
                ])
                .to_owned(),
            )
            .exec(&self.0)
            .await?;
        Ok(())
    }
}
