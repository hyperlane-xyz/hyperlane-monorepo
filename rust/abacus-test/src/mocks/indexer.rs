#![allow(non_snake_case)]

use async_trait::async_trait;
use eyre::Result;
use mockall::*;

use abacus_core::{AbacusCommonIndexer, Indexer, OutboxIndexer, *};

mock! {
    pub Indexer {
        pub fn _get_finalized_block_number(&self) -> Result<u32> {}

        pub fn _fetch_sorted_messages(&self, from: u32, to: u32) -> Result<Vec<RawCommittedMessage>> {}
    }
}

impl std::fmt::Debug for MockIndexer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MockIndexer")
    }
}

mock! {
    pub AbacusIndexer {
        pub fn _get_finalized_block_number(&self) -> Result<u32> {}

        pub fn _fetch_sorted_checkpoints(&self, from: u32, to: u32) -> Result<Vec<CheckpointWithMeta>> {}

        pub fn _fetch_sorted_messages(&self, from: u32, to: u32) -> Result<Vec<RawCommittedMessage>> {}
    }
}

impl std::fmt::Debug for MockAbacusIndexer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MockAbacusIndexer")
    }
}

#[async_trait]
impl Indexer for MockAbacusIndexer {
    async fn get_finalized_block_number(&self) -> Result<u32> {
        self._get_finalized_block_number()
    }
}

#[async_trait]
impl AbacusCommonIndexer for MockAbacusIndexer {
    async fn fetch_sorted_checkpoints(
        &self,
        from: u32,
        to: u32,
    ) -> Result<Vec<CheckpointWithMeta>> {
        self._fetch_sorted_checkpoints(from, to)
    }
}

#[async_trait]
impl OutboxIndexer for MockAbacusIndexer {
    async fn fetch_sorted_messages(&self, from: u32, to: u32) -> Result<Vec<RawCommittedMessage>> {
        self._fetch_sorted_messages(from, to)
    }
}
