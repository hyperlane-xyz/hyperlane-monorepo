use std::collections::HashMap;

use async_trait::async_trait;
use eyre::{eyre, Result};

use hyperlane_core::{
    HyperlaneLogStore, HyperlaneSequenceAwareIndexerStoreReader, Indexed, LogMeta,
    MerkleTreeInsertion, H512,
};

use crate::db::StorableMerkleTreeInsertion;
use crate::store::storage::{HyperlaneDbStore, TxnWithId};

#[async_trait]
impl HyperlaneLogStore<MerkleTreeInsertion> for HyperlaneDbStore {
    async fn store_logs(
        &self,
        insertions: &[(Indexed<MerkleTreeInsertion>, LogMeta)],
    ) -> Result<u32> {
        if insertions.is_empty() {
            return Ok(0);
        }

        let txns: HashMap<H512, TxnWithId> = self
            .ensure_all_blocks_and_txns(insertions.iter().map(|r| &r.1))
            .await?;
        let storable = insertions
            .iter()
            .map(|(insertion, meta)| {
                let txn = txns
                    .get(&meta.transaction_id)
                    .ok_or_else(|| eyre!("missing checked transaction metadata"))?;
                Ok(StorableMerkleTreeInsertion {
                    insertion: insertion.inner(),
                    txn_id: txn.id,
                })
            })
            .collect::<Result<Vec<_>>>()?;

        let stored = self
            .db
            .store_merkle_tree_insertions(
                self.domain.id(),
                &self.merkle_tree_hook_address,
                storable.into_iter(),
            )
            .await?;
        Ok(stored as u32)
    }
}

#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<MerkleTreeInsertion> for HyperlaneDbStore {
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<MerkleTreeInsertion>> {
        self.db
            .retrieve_merkle_tree_insertion_by_leaf_index(
                self.domain.id(),
                &self.merkle_tree_hook_address,
                sequence,
            )
            .await
    }

    async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> Result<Option<u64>> {
        self.db
            .retrieve_merkle_tree_insertion_block_number_by_leaf_index(
                self.domain.id(),
                &self.merkle_tree_hook_address,
                sequence,
            )
            .await
    }
}
