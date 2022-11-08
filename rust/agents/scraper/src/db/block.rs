use std::hash::{Hash, Hasher};

use ethers::prelude::H256;
use eyre::{Context, Result};
use sea_orm::{
    prelude::*, ActiveValue::*, DbErr, EntityTrait, FromQueryResult, Insert, QueryResult,
    QuerySelect,
};
use tracing::trace;

use abacus_core::BlockInfo;

use crate::conversions::{format_h256, parse_h256};
use crate::date_time;
use crate::db::ScraperDb;

use super::generated::block;

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

impl ScraperDb {
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

    pub async fn record_blocks(
        &self,
        domain: u32,
        blocks: impl Iterator<Item = BlockInfo>,
    ) -> Result<i64> {
        let models = blocks
            .map(|info| block::ActiveModel {
                id: NotSet,
                hash: Set(format_h256(&info.hash)),
                time_created: Set(date_time::now()),
                domain: Unchanged(domain as i32),
                height: Unchanged(info.number as i64),
                timestamp: Set(date_time::from_unix_timestamp_s(info.timestamp)),
            })
            .collect::<Vec<_>>();

        debug_assert!(!models.is_empty());
        trace!(?models, "Writing blocks to database");
        let first_id = Insert::many(models).exec(&self.0).await?.last_insert_id;
        Ok(first_id)
    }
}
