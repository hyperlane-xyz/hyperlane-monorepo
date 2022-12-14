#![allow(non_snake_case)]

use async_trait::async_trait;
use mockall::*;

use hyperlane_core::{ChainResult, HyperlaneMessage, Indexer, LogMeta, MailboxIndexer, H256};

mock! {
    pub Indexer {
        pub fn _get_finalized_block_number(&self) -> ChainResult<u32> {}

        pub fn _fetch_sorted_messages(&self, from: u32, to: u32) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {}
    }
}

impl std::fmt::Debug for MockIndexer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MockIndexer")
    }
}

mock! {
    pub HyperlaneIndexer {
        pub fn _get_finalized_block_number(&self) -> ChainResult<u32> {}
        pub fn _fetch_sorted_messages(&self, from: u32, to: u32) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {}
        pub fn _fetch_delivered_messages(&self, from: u32, to: u32) -> ChainResult<Vec<(H256, LogMeta)>> {}
    }
}

impl std::fmt::Debug for MockHyperlaneIndexer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MockHyperlaneIndexer")
    }
}

#[async_trait]
impl Indexer for MockHyperlaneIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self._get_finalized_block_number()
    }
}

#[async_trait]
impl MailboxIndexer for MockHyperlaneIndexer {
    async fn fetch_sorted_messages(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {
        self._fetch_sorted_messages(from, to)
    }

    async fn fetch_delivered_messages(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(H256, LogMeta)>> {
        self._fetch_delivered_messages(from, to)
    }
}
