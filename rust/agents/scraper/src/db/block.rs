use eyre::{Context, Result};
use sea_orm::{
    prelude::*, ActiveValue::*, DbErr, EntityTrait, FromQueryResult, Insert, QueryResult,
    QuerySelect,
};
use tracing::{debug, trace};

use hyperlane_core::{BlockInfo, H256};

use crate::conversions::{address_to_bytes, h256_to_bytes};
use crate::date_time;
use crate::db::ScraperDb;

use super::generated::block;

/// A stripped down block model. This is so we can get just the information
/// needed if the block is present in the Db already to inject into other
/// models.
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
            hash: H256::from_slice(&res.try_get::<Vec<u8>>(pre, "hash")?),
            timestamp: res.try_get::<TimeDateTime>(pre, "timestamp")?,
        })
    }
}

impl ScraperDb {
    /// Get basic block data that can be used to insert a transaction or
    /// message. Any blocks which are not found will be excluded from the
    /// response.
    pub async fn get_block_basic(
        &self,
        hashes: impl Iterator<Item = &H256>,
    ) -> Result<Vec<BasicBlock>> {
        // check database to see which blocks we already know and fetch their IDs
        let blocks = block::Entity::find()
            .filter(block::Column::Hash.is_in(hashes.map(h256_to_bytes)))
            .select_only()
            // these must align with the custom impl of FromQueryResult
            .column_as(block::Column::Id, "id")
            .column_as(block::Column::Hash, "hash")
            .column_as(block::Column::Timestamp, "timestamp")
            .into_model::<BasicBlock>()
            .all(&self.0)
            .await
            .context("When querying blocks")?;

        debug!(blocks = blocks.len(), "Queried block info for hashes");
        Ok(blocks)
    }

    /// Store a new block (or update an existing one)
    pub async fn store_blocks(
        &self,
        domain: u32,
        blocks: impl Iterator<Item = BlockInfo>,
    ) -> Result<i64> {
        let models = blocks
            .map(|info| block::ActiveModel {
                id: NotSet,
                hash: Set(address_to_bytes(&info.hash)),
                time_created: Set(date_time::now()),
                domain: Unchanged(domain as i32),
                height: Unchanged(info.number as i64),
                timestamp: Set(date_time::from_unix_timestamp_s(info.timestamp)),
            })
            .collect::<Vec<_>>();

        debug_assert!(!models.is_empty());
        let id_offset = models.len() as i64 - 1;
        debug!(blocks = models.len(), "Writing blocks to database");
        trace!(?models, "Writing blocks to database");
        let first_id = Insert::many(models).exec(&self.0).await?.last_insert_id - id_offset;
        debug_assert!(first_id > 0);
        Ok(first_id)
    }
}
