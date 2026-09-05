use eyre::{Context, Result};
use itertools::Itertools;
use migration::OnConflict;
use sea_orm::{
    prelude::*,
    sea_query::{Query, SelectStatement},
    ActiveValue::*,
    ConnectionTrait, DbErr, EntityTrait, FromQueryResult, Insert, QueryResult, QuerySelect,
    QueryTrait,
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
        let hashes = hashes.unique().collect_vec();
        let mut blocks = Vec::new();
        for hashes in hashes.chunks(Self::HASH_LOOKUP_CHUNK_SIZE) {
            blocks.extend(
                block::Entity::find()
                    .filter(
                        block::Column::Hash.is_in(hashes.iter().map(|hash| h256_to_bytes(hash))),
                    )
                    .select_only()
                    // These must align with the custom impl of FromQueryResult.
                    .column_as(block::Column::Id, "id")
                    .column_as(block::Column::Hash, "hash")
                    .into_model::<BasicBlock>()
                    .all(&self.0)
                    .await
                    .context("When querying blocks")?,
            );
        }

        trace!(blocks = blocks.len(), "Queried block info for hashes");
        Ok(blocks)
    }

    /// Store blocks and return the IDs/hashes of inserted rows. Conflicts are omitted.
    pub async fn store_blocks(
        &self,
        domain: u32,
        blocks: impl Iterator<Item = BlockInfo>,
    ) -> Result<Vec<BasicBlock>> {
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

        if models.is_empty() {
            return Ok(Vec::new());
        }
        debug!(blocks = models.len(), "Writing blocks to database");
        trace!(?models, "Writing blocks to database");
        let mut query = Insert::many(models)
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .into_query();
        query.returning(Query::returning().columns([block::Column::Id, block::Column::Hash]));
        self.0
            .query_all(self.0.get_database_backend().build(&query))
            .await
            .context("When inserting blocks")?
            .iter()
            .map(|row| BasicBlock::from_query_result(row, "").map_err(Into::into))
            .collect()
    }
}

#[cfg(test)]
mod tests;
