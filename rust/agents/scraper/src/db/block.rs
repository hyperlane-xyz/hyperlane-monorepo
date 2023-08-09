use eyre::{Context, Result};
use sea_orm::{
    prelude::*, ActiveValue::*, DbErr, EntityTrait, FromQueryResult, Insert, QueryResult,
    QuerySelect,
};
use tracing::{debug, trace};

use hyperlane_core::{BlockInfo, H256};
use migration::OnConflict;

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
}

impl FromQueryResult for BasicBlock {
    fn from_query_result(res: &QueryResult, pre: &str) -> std::result::Result<Self, DbErr> {
        Ok(Self {
            id: res.try_get::<i64>(pre, "id")?,
            hash: H256::from_slice(&res.try_get::<Vec<u8>>(pre, "hash")?),
        })
    }
}

impl ScraperDb {
    /// Retrieves the block number for a given block database ID
    pub async fn retrieve_block_number(&self, block_id: i64) -> Result<Option<u64>> {
        #[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
        enum QueryAs {
            Height,
        }
        let block_height = block::Entity::find()
            .filter(block::Column::Id.eq(block_id))
            .select_only()
            .column_as(block::Column::Height, QueryAs::Height)
            .into_values::<i64, QueryAs>()
            .one(&self.0)
            .await?;
        match block_height {
            Some(height) => Ok(Some(height.try_into()?)),
            None => Ok(None),
        }
    }

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
            .into_model::<BasicBlock>()
            .all(&self.0)
            .await
            .context("When querying blocks")?;

        trace!(blocks = blocks.len(), "Queried block info for hashes");
        Ok(blocks)
    }

    /// Store a new block (or update an existing one)
    pub async fn store_blocks(
        &self,
        domain: u32,
        blocks: impl Iterator<Item = BlockInfo>,
    ) -> Result<()> {
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
        debug!(blocks = models.len(), "Writing blocks to database");
        trace!(?models, "Writing blocks to database");
        match Insert::many(models)
            .on_conflict(
                OnConflict::column(block::Column::Hash)
                    .do_nothing()
                    .to_owned(),
            )
            .exec(&self.0)
            .await
        {
            Ok(_) => Ok(()),
            Err(DbErr::RecordNotInserted) => Ok(()),
            Err(e) => Err(e).context("When inserting blocks"),
        }
    }
}
