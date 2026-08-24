use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{
    HyperlaneLogStore, HyperlaneSequenceAwareIndexerStoreReader, Indexed, LogMeta,
    MerkleTreeInsertion,
};

use crate::db::StorableMerkleTreeInsertion;
use crate::store::HyperlaneDbStore;

#[async_trait]
impl HyperlaneLogStore<MerkleTreeInsertion> for HyperlaneDbStore {
    async fn store_logs(
        &self,
        insertions: &[(Indexed<MerkleTreeInsertion>, LogMeta)],
    ) -> Result<u32> {
        let rows = insertions
            .iter()
            .map(|(insertion, meta)| StorableMerkleTreeInsertion {
                insertion: insertion.inner(),
                block_number: meta.block_number,
            });
        Ok(self
            .db
            .store_merkle_tree_insertions(self.domain.id(), &self.merkle_tree_hook_address, rows)
            .await? as u32)
    }
}

#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<MerkleTreeInsertion> for HyperlaneDbStore {
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<MerkleTreeInsertion>> {
        Ok(self
            .db
            .retrieve_merkle_tree_insertion(
                self.domain.id(),
                &self.merkle_tree_hook_address,
                sequence,
            )
            .await?
            .map(|(insertion, _)| insertion))
    }

    async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> Result<Option<u64>> {
        Ok(self
            .db
            .retrieve_merkle_tree_insertion(
                self.domain.id(),
                &self.merkle_tree_hook_address,
                sequence,
            )
            .await?
            .map(|(_, block_number)| block_number))
    }
}
