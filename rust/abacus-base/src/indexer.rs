use abacus_core::{AbacusCommonIndexer, CheckpointWithMeta, OutboxIndexer, RawCommittedMessage};
use abacus_test::mocks::indexer::MockAbacusIndexer;
use async_trait::async_trait;
use color_eyre::Result;

/// Outbox/Inbox CommonIndexer type
#[derive(Debug)]
pub enum AbacusCommonIndexers {
    /// Ethereum contract indexer
    Ethereum(Box<dyn AbacusCommonIndexer>),
    /// Mock indexer
    Mock(Box<dyn AbacusCommonIndexer>),
    /// Other indexer variant
    Other(Box<dyn AbacusCommonIndexer>),
}

impl From<MockAbacusIndexer> for AbacusCommonIndexers {
    fn from(mock_indexer: MockAbacusIndexer) -> Self {
        AbacusCommonIndexers::Mock(Box::new(mock_indexer))
    }
}

#[async_trait]
impl AbacusCommonIndexer for AbacusCommonIndexers {
    async fn get_block_number(&self) -> Result<u32> {
        match self {
            AbacusCommonIndexers::Ethereum(indexer) => indexer.get_block_number().await,
            AbacusCommonIndexers::Mock(indexer) => indexer.get_block_number().await,
            AbacusCommonIndexers::Other(indexer) => indexer.get_block_number().await,
        }
    }

    async fn fetch_sorted_checkpoints(
        &self,
        from: u32,
        to: u32,
    ) -> Result<Vec<CheckpointWithMeta>> {
        match self {
            AbacusCommonIndexers::Ethereum(indexer) => {
                indexer.fetch_sorted_checkpoints(from, to).await
            }
            AbacusCommonIndexers::Mock(indexer) => indexer.fetch_sorted_checkpoints(from, to).await,
            AbacusCommonIndexers::Other(indexer) => {
                indexer.fetch_sorted_checkpoints(from, to).await
            }
        }
    }
}

/// OutboxIndexer type
#[derive(Debug)]
pub enum OutboxIndexers {
    /// Ethereum contract indexer
    Ethereum(Box<dyn OutboxIndexer>),
    /// Mock indexer
    Mock(Box<dyn OutboxIndexer>),
    /// Other indexer variant
    Other(Box<dyn OutboxIndexer>),
}

impl From<MockAbacusIndexer> for OutboxIndexers {
    fn from(mock_indexer: MockAbacusIndexer) -> Self {
        OutboxIndexers::Mock(Box::new(mock_indexer))
    }
}

#[async_trait]
impl AbacusCommonIndexer for OutboxIndexers {
    async fn get_block_number(&self) -> Result<u32> {
        match self {
            OutboxIndexers::Ethereum(indexer) => indexer.get_block_number().await,
            OutboxIndexers::Mock(indexer) => indexer.get_block_number().await,
            OutboxIndexers::Other(indexer) => indexer.get_block_number().await,
        }
    }

    async fn fetch_sorted_checkpoints(
        &self,
        from: u32,
        to: u32,
    ) -> Result<Vec<CheckpointWithMeta>> {
        match self {
            OutboxIndexers::Ethereum(indexer) => indexer.fetch_sorted_checkpoints(from, to).await,
            OutboxIndexers::Mock(indexer) => indexer.fetch_sorted_checkpoints(from, to).await,
            OutboxIndexers::Other(indexer) => indexer.fetch_sorted_checkpoints(from, to).await,
        }
    }
}

#[async_trait]
impl OutboxIndexer for OutboxIndexers {
    async fn fetch_sorted_messages(&self, from: u32, to: u32) -> Result<Vec<RawCommittedMessage>> {
        match self {
            OutboxIndexers::Ethereum(indexer) => indexer.fetch_sorted_messages(from, to).await,
            OutboxIndexers::Mock(indexer) => indexer.fetch_sorted_messages(from, to).await,
            OutboxIndexers::Other(indexer) => indexer.fetch_sorted_messages(from, to).await,
        }
    }
}
