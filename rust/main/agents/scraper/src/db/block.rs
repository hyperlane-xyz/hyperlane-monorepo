use eyre::{Context, Result};
use migration::OnConflict;
use sea_orm::{
    prelude::*, sea_query::SelectStatement, ActiveValue::*, DbErr, EntityTrait, FromQueryResult,
    Insert, QueryResult, QuerySelect,
};
use tracing::{debug, trace};

use hyperlane_core::{h256_to_bytes, BlockInfo, H256};

use crate::date_time;
use crate::db::ScraperDb;

use super::generated::{block, transaction};

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
    /// Resolve a query selecting one event transaction id to its block height in
    /// one database round trip. NULL/missing relations produce no height.
    pub(super) async fn retrieve_block_number_by_tx_query(
        &self,
        tx_id_query: SelectStatement,
    ) -> Result<Option<u64>> {
        let height = transaction::Entity::find()
            .filter(transaction::Column::Id.in_subquery(tx_id_query))
            .inner_join(block::Entity)
            .select_only()
            .column(block::Column::Height)
            .into_tuple::<i64>()
            .one(&self.0)
            .await?;
        height.map(u64::try_from).transpose().map_err(Into::into)
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
                hash: Set(h256_to_bytes(&info.hash)),
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
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .exec(&self.0)
            .await
        {
            Ok(_) => Ok(()),
            Err(DbErr::RecordNotInserted) => Ok(()),
            Err(e) => Err(e).context("When inserting blocks"),
        }
    }
}

#[cfg(test)]
mod tests;
