#![allow(dead_code)] // TODO: `rustc` 1.80.1 clippy issue

use eyre::Result;
use itertools::Itertools;
use sea_orm::{prelude::*, ActiveValue::*, Insert};
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
    /// Store raw message dispatches into the database.
    /// This method stores raw message dispatch data that comes directly from event logs,
    /// requiring zero RPC calls. This enables CCTP to query transaction hashes even when
    /// RPC providers are failing.
    #[instrument(skip_all)]
    pub async fn store_raw_message_dispatches(
        &self,
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

        // Count how many new records we're inserting
        let count_before_insert = models.len() as u64;

        // Insert with ON CONFLICT to handle duplicates (msg_id is unique)
        Insert::many(models)
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
            .exec(&self.0)
            .await?;

        debug!(
            messages = count_before_insert,
            "Wrote raw message dispatches to database"
        );
        Ok(count_before_insert)
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
    use super::*;
    use hyperlane_core::{HyperlaneMessage, LogMeta, H256, U256};

    #[tokio::test]
    async fn test_store_raw_message_dispatches_empty() {
        use sea_orm::DatabaseBackend;
        use sea_orm::MockDatabase;

        let mock_db = MockDatabase::new(DatabaseBackend::Postgres).into_connection();
        let scraper_db = ScraperDb::with_connection(mock_db);

        let messages: Vec<StorableRawMessageDispatch> = vec![];
        let result = scraper_db
            .store_raw_message_dispatches(1, &H256::zero(), messages.into_iter())
            .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);
    }

    #[tokio::test]
    async fn test_storable_raw_message_dispatch_creation() {
        let msg = HyperlaneMessage::default();
        let meta = LogMeta {
            transaction_id: H256::from_low_u64_be(1),
            block_hash: H256::from_low_u64_be(2),
            block_number: 100,
            transaction_index: 5,
            log_index: U256::from(10),
            ..Default::default()
        };

        let storable = StorableRawMessageDispatch {
            msg: &msg,
            meta: &meta,
        };

        assert_eq!(storable.msg.id(), msg.id());
        assert_eq!(storable.meta.transaction_id, meta.transaction_id);
        assert_eq!(storable.meta.block_number, 100);
    }
}
