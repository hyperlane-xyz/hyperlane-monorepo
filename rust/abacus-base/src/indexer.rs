use abacus_core::{
    AbacusCommonIndexer, CheckpointWithMeta, Indexer, InterchainGasPaymasterIndexer,
    InterchainGasPayment, OutboxIndexer, RawCommittedMessage,
};
use abacus_test::mocks::indexer::MockAbacusIndexer;
use async_trait::async_trait;
use eyre::Result;

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
impl Indexer for AbacusCommonIndexers {
    async fn get_block_number(&self) -> Result<u32> {
        match self {
            AbacusCommonIndexers::Ethereum(indexer) => indexer.get_block_number().await,
            AbacusCommonIndexers::Mock(indexer) => indexer.get_block_number().await,
            AbacusCommonIndexers::Other(indexer) => indexer.get_block_number().await,
        }
    }
}

#[async_trait]
impl AbacusCommonIndexer for AbacusCommonIndexers {
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
impl Indexer for OutboxIndexers {
    async fn get_block_number(&self) -> Result<u32> {
        match self {
            OutboxIndexers::Ethereum(indexer) => indexer.get_block_number().await,
            OutboxIndexers::Mock(indexer) => indexer.get_block_number().await,
            OutboxIndexers::Other(indexer) => indexer.get_block_number().await,
        }
    }
}

#[async_trait]
impl AbacusCommonIndexer for OutboxIndexers {
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

/// InterchainGasPaymasterIndexer type
#[derive(Debug)]
pub enum InterchainGasPaymasterIndexers {
    /// Ethereum contract indexer
    Ethereum(Box<dyn InterchainGasPaymasterIndexer>),
    /// Mock indexer
    Mock(Box<dyn InterchainGasPaymasterIndexer>),
    /// Other indexer variant
    Other(Box<dyn InterchainGasPaymasterIndexer>),
}

#[async_trait]
impl Indexer for InterchainGasPaymasterIndexers {
    async fn get_block_number(&self) -> Result<u32> {
        match self {
            InterchainGasPaymasterIndexers::Ethereum(indexer) => indexer.get_block_number().await,
            InterchainGasPaymasterIndexers::Mock(indexer) => indexer.get_block_number().await,
            InterchainGasPaymasterIndexers::Other(indexer) => indexer.get_block_number().await,
        }
    }
}

#[async_trait]
impl InterchainGasPaymasterIndexer for InterchainGasPaymasterIndexers {
    async fn fetch_gas_payments(
        &self,
        from_block: u32,
        to_block: u32,
    ) -> Result<Vec<InterchainGasPayment>> {
        match self {
            InterchainGasPaymasterIndexers::Ethereum(indexer) => {
                indexer.fetch_gas_payments(from_block, to_block).await
            }
            InterchainGasPaymasterIndexers::Mock(indexer) => {
                indexer.fetch_gas_payments(from_block, to_block).await
            }
            InterchainGasPaymasterIndexers::Other(indexer) => {
                indexer.fetch_gas_payments(from_block, to_block).await
            }
        }
    }
}
