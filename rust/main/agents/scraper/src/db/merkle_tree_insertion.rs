use eyre::Result;
use itertools::Itertools;
use migration::OnConflict;
use sea_orm::{ActiveValue::*, ColumnTrait, EntityTrait, Insert, QueryFilter, QuerySelect};
use tracing::{debug, instrument, trace};

use hyperlane_core::{address_to_bytes, h256_to_bytes, MerkleTreeInsertion, H256};

use crate::{date_time, db::ScraperDb};

use super::generated::merkle_tree_insertion;

pub struct StorableMerkleTreeInsertion<'a> {
    pub insertion: &'a MerkleTreeInsertion,
    pub txn_id: i64,
}

impl ScraperDb {
    #[instrument(skip_all)]
    pub async fn store_merkle_tree_insertions(
        &self,
        domain: u32,
        merkle_tree_hook: &H256,
        insertions: impl Iterator<Item = StorableMerkleTreeInsertion<'_>>,
    ) -> Result<u64> {
        let merkle_tree_hook = address_to_bytes(merkle_tree_hook);
        let models = insertions
            .map(|storable| merkle_tree_insertion::ActiveModel {
                id: NotSet,
                time_created: Set(date_time::now()),
                domain: Unchanged(domain as i32),
                merkle_tree_hook: Unchanged(merkle_tree_hook.clone()),
                leaf_index: Unchanged(storable.insertion.index() as i32),
                message_id: Set(h256_to_bytes(&storable.insertion.message_id())),
                origin_tx_id: Set(storable.txn_id),
            })
            .collect_vec();

        trace!(?models, "Writing merkle tree insertions to database");

        if models.is_empty() {
            debug!("Wrote zero merkle tree insertions to database");
            return Ok(0);
        }

        let inserted = models.len() as u64;
        Insert::many(models)
            .on_conflict(
                OnConflict::columns([
                    merkle_tree_insertion::Column::Domain,
                    merkle_tree_insertion::Column::MerkleTreeHook,
                    merkle_tree_insertion::Column::LeafIndex,
                ])
                .update_columns([
                    merkle_tree_insertion::Column::TimeCreated,
                    merkle_tree_insertion::Column::MessageId,
                    merkle_tree_insertion::Column::OriginTxId,
                ])
                .to_owned(),
            )
            .exec(&self.0)
            .await?;

        debug!(
            insertions = inserted,
            "Wrote merkle tree insertions to database"
        );
        Ok(inserted)
    }

    pub async fn retrieve_merkle_tree_insertion_by_leaf_index(
        &self,
        domain: u32,
        merkle_tree_hook: &H256,
        leaf_index: u32,
    ) -> Result<Option<MerkleTreeInsertion>> {
        let row = merkle_tree_insertion::Entity::find()
            .filter(merkle_tree_insertion::Column::Domain.eq(domain))
            .filter(
                merkle_tree_insertion::Column::MerkleTreeHook
                    .eq(address_to_bytes(merkle_tree_hook)),
            )
            .filter(merkle_tree_insertion::Column::LeafIndex.eq(leaf_index))
            .one(&self.0)
            .await?;

        Ok(row.map(|row| {
            MerkleTreeInsertion::new(
                row.leaf_index as u32,
                H256::from_slice(row.message_id.as_slice()),
            )
        }))
    }

    pub async fn retrieve_merkle_tree_insertion_block_number_by_leaf_index(
        &self,
        domain: u32,
        merkle_tree_hook: &H256,
        leaf_index: u32,
    ) -> Result<Option<u64>> {
        let tx_id = merkle_tree_insertion::Entity::find()
            .filter(merkle_tree_insertion::Column::Domain.eq(domain))
            .filter(
                merkle_tree_insertion::Column::MerkleTreeHook
                    .eq(address_to_bytes(merkle_tree_hook)),
            )
            .filter(merkle_tree_insertion::Column::LeafIndex.eq(leaf_index))
            .select_only()
            .column(merkle_tree_insertion::Column::OriginTxId)
            .into_tuple::<i64>()
            .one(&self.0)
            .await?;

        let Some(tx_id) = tx_id else {
            return Ok(None);
        };
        let Some(block_id) = self.retrieve_block_id(tx_id).await? else {
            return Ok(None);
        };
        self.retrieve_block_number(block_id).await
    }
}
