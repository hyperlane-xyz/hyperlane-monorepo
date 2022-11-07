use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::ops::Deref;

use ethers::prelude::H256;
use eyre::{Context, eyre, Result};
use sea_orm::{FromQueryResult, Insert, prelude::*, QueryOrder, QuerySelect};
use sea_orm::{Database, SelectorTrait};
use sea_orm::ActiveValue::*;
use sea_orm::DbErr;
use sea_orm::sea_query::OnConflict;
use tracing::{instrument, trace};

use abacus_core::{BlockInfo, CommittedMessage, LogMeta, TxnInfo};
pub use block_cursor::BlockCursor;
use generated::*;
pub use message_linker::delivered_message_linker;

use crate::conversions::{format_h256, parse_h256, u256_as_scaled_f64};
use crate::date_time;

#[allow(clippy::all)]
mod generated;

mod block_cursor;
mod message_linker;

pub struct StorableMessage<'a> {
    pub msg: CommittedMessage,
    pub meta: &'a LogMeta,
    /// The database id of the transaction the message was sent in
    pub txn_id: i64,
    pub timestamp: TimeDateTime,
}

#[derive(Debug, Clone)]
pub struct StorableDelivery<'a> {
    pub inbox: H256,
    pub message_hash: H256,
    pub meta: &'a LogMeta,
    /// The database id of the transaction the delivery event occurred in
    pub txn_id: i64,
}

#[derive(Debug, Clone)]
pub struct StorableTxn {
    pub info: TxnInfo,
    pub block_id: i64,
}

/// A stripped down block model.
#[derive(Debug, Clone)]
pub struct BasicBlock {
    /// the database id of this block
    pub id: i64,
    pub hash: H256,
    pub timestamp: TimeDateTime,
}

impl FromQueryResult for BasicBlock {
    fn from_query_result(res: &QueryResult, pre: &str) -> std::result::Result<Self, DbErr> {
        Ok(Self {
            id: res.try_get::<i64>(pre, "id")?,
            hash: parse_h256(res.try_get::<String>(pre, "hash")?)
                .map_err(|e| DbErr::Type(e.to_string()))?,
            timestamp: res.try_get::<TimeDateTime>(pre, "timestamp")?,
        })
    }
}

impl Hash for BasicBlock {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.hash.hash(state);
    }
}

impl Deref for StorableTxn {
    type Target = TxnInfo;

    fn deref(&self) -> &Self::Target {
        &self.info
    }
}

#[derive(Clone)]
pub struct ScraperDb(DbConn);

impl ScraperDb {
    #[instrument]
    pub async fn connect(url: &str) -> Result<Self> {
        let db = Database::connect(url).await?;
        Ok(Self(db))
    }

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

    /// Store messages from the outbox into the database.
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

    #[instrument(skip_all)]
    pub async fn record_deliveries(
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
                time_created: Set(crate::date_time::now()),
                msg_id: NotSet,
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

    pub async fn get_txn_ids(
        &self,
        hashes: impl Iterator<Item = &H256>,
    ) -> Result<HashMap<H256, i64>> {
        #[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
        enum QueryAs {
            Id,
            Hash,
        }

        // check database to see which txns we already know and fetch their IDs
        transaction::Entity::find()
            .filter(
                hashes
                    .map(|txn| transaction::Column::Hash.eq(format_h256(txn)))
                    .reduce(|acc, i| acc.or(i))
                    .expect("Expected one or more hashes"),
            )
            .select_only()
            .column_as(transaction::Column::Id, QueryAs::Id)
            .column_as(transaction::Column::Hash, QueryAs::Hash)
            .into_values::<(i64, String), QueryAs>()
            .all(&self.0)
            .await
            .context("When fetching transactions")?
            .into_iter()
            .map(|(id, hash)| Ok((parse_h256(&hash)?, id)))
            .collect::<Result<_>>()
    }

    #[instrument(skip_all)]
    pub async fn record_txns(&self, txns: impl Iterator<Item = StorableTxn>) -> Result<i64> {
        let models = txns
            .map(|txn| {
                let receipt = txn
                    .receipt
                    .as_ref()
                    .ok_or_else(|| eyre!("Transaction is not yet included"))?;

                Ok(transaction::ActiveModel {
                    id: NotSet,
                    block_id: Unchanged(txn.block_id),
                    gas_limit: Set(as_f64(txn.gas_limit)),
                    max_priority_fee_per_gas: Set(txn.max_priority_fee_per_gas.map(as_f64)),
                    hash: Unchanged(format_h256(&txn.hash)),
                    time_created: Set(date_time::now()),
                    gas_used: Set(as_f64(receipt.gas_used)),
                    gas_price: Set(txn.gas_price.map(as_f64)),
                    effective_gas_price: Set(receipt.effective_gas_price.map(as_f64)),
                    nonce: Set(txn.nonce as i64),
                    sender: Set(format_h256(&txn.sender)),
                    recipient: Set(txn.recipient.as_ref().map(format_h256)),
                    max_fee_per_gas: Set(txn.max_priority_fee_per_gas.map(as_f64)),
                    cumulative_gas_used: Set(as_f64(receipt.cumulative_gas_used)),
                })
            })
            .collect::<Result<Vec<_>>>()?;

        debug_assert!(!models.is_empty());
        trace!(?models, "Writing txns to database");
        // this is actually the ID that was first inserted for postgres
        let first_id = Insert::many(models).exec(&self.0).await?.last_insert_id;
        Ok(first_id)
    }

    pub async fn get_block_basic(
        &self,
        hashes: impl Iterator<Item = &H256>,
    ) -> Result<Vec<BasicBlock>> {
        // check database to see which blocks we already know and fetch their IDs
        block::Entity::find()
            .filter(
                hashes
                    .map(|hash| block::Column::Hash.eq(format_h256(hash)))
                    .reduce(|acc, i| acc.or(i))
                    .unwrap(),
            )
            .select_only()
            // these must align with the custom impl of FromQueryResult
            .column_as(block::Column::Id, "id")
            .column_as(block::Column::Hash, "hash")
            .column_as(block::Column::Timestamp, "timestamp")
            .into_model::<BasicBlock>()
            .all(&self.0)
            .await
            .context("When fetching blocks")
    }

    pub async fn record_blocks(&self, domain: u32, blocks: impl Iterator<Item = BlockInfo>) -> Result<i64> {
        let models = blocks.map(|info| block::ActiveModel {
            id: NotSet,
            hash: Set(format_h256(&info.hash)),
            time_created: Set(date_time::now()),
            domain: Unchanged(domain as i32),
            height: Unchanged(info.number as i64),
            timestamp: Set(date_time::from_unix_timestamp_s(info.timestamp)),
            gas_used: Set(as_f64(info.gas_used)),
            gas_limit: Set(as_f64(info.gas_limit)),
        }).collect::<Vec<_>>();

        debug_assert!(!models.is_empty());
        trace!(?models, "Writing blocks to database");
        let first_id = Insert::many(models).exec(&self.0).await?.last_insert_id;
        Ok(first_id)
    }
}

fn as_f64(v: ethers::types::U256) -> f64 {
    u256_as_scaled_f64(v, 18)
}
