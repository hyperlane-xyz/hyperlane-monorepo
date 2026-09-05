use std::collections::HashSet;

use eyre::{ensure, Result};
use migration::OnConflict;
use sea_orm::{
    ActiveValue::*, ColumnTrait, DbErr, EntityTrait, Insert, QueryFilter, TransactionTrait,
};

use hyperlane_core::{address_to_bytes, h256_to_bytes, MerkleTreeInsertion, H256};

use super::{generated::merkle_tree_insertion, ScraperDb};

pub struct StorableMerkleTreeInsertion<'a> {
    pub insertion: &'a MerkleTreeInsertion,
    pub block_number: u64,
}

// Each row binds five columns; conflict updates reference EXCLUDED and add no
// parameters. Keep each statement below PostgreSQL's 65,535-parameter limit.
const INSERT_CHUNK_SIZE: usize = 13_000;

impl ScraperDb {
    pub async fn store_merkle_tree_insertions(
        &self,
        domain: u32,
        merkle_tree_hook: &H256,
        insertions: impl Iterator<Item = StorableMerkleTreeInsertion<'_>>,
    ) -> Result<u64> {
        let merkle_tree_hook = address_to_bytes(merkle_tree_hook);
        // A single PostgreSQL upsert rejects repeated conflict keys. Preserve
        // that rejection even when repeated leaves fall into different chunks.
        let mut leaf_indices = HashSet::new();
        let models = insertions
            .map(|row| {
                ensure!(
                    leaf_indices.insert(row.insertion.index()),
                    "Duplicate Merkle tree leaf index {} in one batch",
                    row.insertion.index()
                );
                Ok(merkle_tree_insertion::ActiveModel {
                    id: NotSet,
                    domain: Unchanged(domain as i32),
                    merkle_tree_hook: Unchanged(merkle_tree_hook.clone()),
                    leaf_index: Unchanged(row.insertion.index() as i32),
                    message_id: Set(h256_to_bytes(&row.insertion.message_id())),
                    block_number: Set(row.block_number as i64),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        drop(leaf_indices);
        let count = models.len() as u64;
        if models.is_empty() {
            return Ok(0);
        }

        if models.len() <= INSERT_CHUNK_SIZE {
            insert_query(models).exec(&self.0).await?;
            return Ok(count);
        }

        // A failed later chunk must roll back earlier writes: ContractSync can
        // advance its cursor only after the entire fetched range is durable.
        self.0
            .transaction::<_, (), DbErr>(|txn| {
                Box::pin(async move {
                    let mut models = models.into_iter();
                    while !models.as_slice().is_empty() {
                        let chunk: Vec<_> = models.by_ref().take(INSERT_CHUNK_SIZE).collect();
                        insert_query(chunk).exec(txn).await?;
                    }
                    Ok(())
                })
            })
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

fn insert_query(
    models: Vec<merkle_tree_insertion::ActiveModel>,
) -> Insert<merkle_tree_insertion::ActiveModel> {
    Insert::many(models).on_conflict(
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
}

#[cfg(test)]
mod tests;
