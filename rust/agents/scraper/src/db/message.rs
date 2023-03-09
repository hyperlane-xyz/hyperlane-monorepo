use eyre::Result;
use itertools::Itertools;
use sea_orm::{
    prelude::*, ActiveValue::*, DeriveColumn, EnumIter, Insert, QueryOrder, QuerySelect,
};
use tracing::{instrument, trace};

use hyperlane_core::{HyperlaneMessage, LogMeta, H256};
use migration::OnConflict;

use crate::conversions::format_h256;
use crate::date_time;
use crate::db::ScraperDb;

use super::generated::{delivered_message, message};

#[derive(Debug, Clone)]
pub struct StorableDelivery<'a> {
    pub message_id: H256,
    pub meta: &'a LogMeta,
    /// The database id of the transaction the delivery event occurred in
    pub txn_id: i64,
}

pub struct StorableMessage<'a> {
    pub msg: HyperlaneMessage,
    pub meta: &'a LogMeta,
    /// The database id of the transaction the message was sent in
    pub txn_id: i64,
    pub timestamp: TimeDateTime,
}

impl ScraperDb {
    /// Get the highest message nonce that is stored in the database.
    #[instrument(skip(self))]
    pub async fn last_message_nonce(
        &self,
        origin_domain: u32,
        origin_mailbox: &H256,
    ) -> Result<Option<u32>> {
        #[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
        enum QueryAs {
            Nonce,
        }

        Ok(message::Entity::find()
            .filter(message::Column::Origin.eq(origin_domain))
            .filter(message::Column::OriginMailbox.eq(format_h256(origin_mailbox)))
            .order_by_desc(message::Column::Nonce)
            .select_only()
            .column_as(message::Column::Nonce, QueryAs::Nonce)
            .into_values::<i32, QueryAs>()
            .one(&self.0)
            .await?
            .map(|idx| idx as u32))
    }

    /// Store deliveries from a mailbox into the database (or update an existing
    /// one).
    #[instrument(skip_all)]
    pub async fn store_deliveries(
        &self,
        domain: u32,
        destination_mailbox: H256,
        deliveries: impl Iterator<Item = StorableDelivery<'_>>,
    ) -> Result<()> {
        let destination_mailbox = format_h256(&destination_mailbox);
        // we have a race condition where a message may not have been scraped yet even
        // though we have received news of delivery on this chain, so the
        // message IDs are looked up in a separate "thread".
        let models = deliveries
            .map(|delivery| delivered_message::ActiveModel {
                id: NotSet,
                time_created: Set(date_time::now()),
                msg_id: Unchanged(format_h256(&delivery.message_id)),
                domain: Unchanged(domain as i32),
                destination_mailbox: Unchanged(destination_mailbox.clone()),
                tx_id: Set(delivery.txn_id),
            })
            .collect_vec();

        debug_assert!(!models.is_empty());
        trace!(?models, "Writing delivered messages to database");

        Insert::many(models)
            .on_conflict(
                OnConflict::columns([delivered_message::Column::MsgId])
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

    /// Store messages from a mailbox into the database (or update an existing
    /// one).
    #[instrument(skip_all)]
    pub async fn store_messages(
        &self,
        origin_mailbox: &H256,
        messages: impl Iterator<Item = StorableMessage<'_>>,
    ) -> Result<()> {
        let models = messages
            .map(|storable| message::ActiveModel {
                id: NotSet,
                time_created: Set(date_time::now()),
                msg_id: Unchanged(format_h256(&storable.msg.id())),
                origin: Unchanged(storable.msg.origin as i32),
                destination: Set(storable.msg.destination as i32),
                nonce: Unchanged(storable.msg.nonce as i32),
                sender: Set(format_h256(&storable.msg.sender)),
                recipient: Set(format_h256(&storable.msg.recipient)),
                msg_body: Set(if storable.msg.body.is_empty() {
                    None
                } else {
                    Some(storable.msg.body)
                }),
                origin_mailbox: Unchanged(format_h256(origin_mailbox)),
                timestamp: Set(storable.timestamp),
                origin_tx_id: Set(storable.txn_id),
            })
            .collect_vec();

        debug_assert!(!models.is_empty());
        trace!(?models, "Writing messages to database");

        Insert::many(models)
            .on_conflict(
                OnConflict::columns([
                    message::Column::OriginMailbox,
                    message::Column::Origin,
                    message::Column::Nonce,
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
