use eyre::Result;
use migration::OnConflict;
use sea_orm::{ActiveValue::*, ColumnTrait, EntityTrait, Insert, QueryFilter};

use hyperlane_core::{address_to_bytes, h256_to_bytes, MerkleTreeInsertion, H256};

use super::{generated::merkle_tree_insertion, ScraperDb};

pub struct StorableMerkleTreeInsertion<'a> {
    pub insertion: &'a MerkleTreeInsertion,
    pub block_number: u64,
}

impl ScraperDb {
    pub async fn store_merkle_tree_insertions(
        &self,
        domain: u32,
        merkle_tree_hook: &H256,
        insertions: impl Iterator<Item = StorableMerkleTreeInsertion<'_>>,
    ) -> Result<u64> {
        let merkle_tree_hook = address_to_bytes(merkle_tree_hook);
        let models = insertions
            .map(|row| merkle_tree_insertion::ActiveModel {
                id: NotSet,
                domain: Unchanged(domain as i32),
                merkle_tree_hook: Unchanged(merkle_tree_hook.clone()),
                leaf_index: Unchanged(row.insertion.index() as i32),
                message_id: Set(h256_to_bytes(&row.insertion.message_id())),
                block_number: Set(row.block_number as i64),
            })
            .collect::<Vec<_>>();
        let count = models.len() as u64;
        if models.is_empty() {
            return Ok(0);
        }

        Insert::many(models)
            .on_conflict(
                OnConflict::columns([
                    merkle_tree_insertion::Column::Domain,
                    merkle_tree_insertion::Column::MerkleTreeHook,
                    merkle_tree_insertion::Column::LeafIndex,
                ])
                .update_columns([
                    merkle_tree_insertion::Column::MessageId,
                    merkle_tree_insertion::Column::BlockNumber,
                ])
                .to_owned(),
            )
            .exec(&self.0)
            .await?;
        Ok(count)
    }

    pub async fn retrieve_merkle_tree_insertion(
        &self,
        domain: u32,
        merkle_tree_hook: &H256,
        leaf_index: u32,
    ) -> Result<Option<(MerkleTreeInsertion, u64)>> {
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
            (
                MerkleTreeInsertion::new(row.leaf_index as u32, H256::from_slice(&row.message_id)),
                row.block_number as u64,
            )
        }))
    }
}
