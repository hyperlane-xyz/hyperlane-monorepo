use abacus_core::{
    CheckpointWithMeta, Indexer, InterchainGasPaymasterIndexer, InterchainGasPaymentWithMeta,
    OutboxIndexer, RawCommittedMessage,
};
use abacus_test::mocks::indexer::MockAbacusIndexer;
use async_trait::async_trait;
use eyre::Result;

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
    async fn get_finalized_block_number(&self) -> Result<u32> {
        match self {
            OutboxIndexers::Ethereum(indexer) => indexer.get_finalized_block_number().await,
            OutboxIndexers::Mock(indexer) => indexer.get_finalized_block_number().await,
            OutboxIndexers::Other(indexer) => indexer.get_finalized_block_number().await,
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

    async fn fetch_sorted_cached_checkpoints(
        &self,
        from: u32,
        to: u32,
    ) -> Result<Vec<CheckpointWithMeta>> {
        match self {
            OutboxIndexers::Ethereum(indexer) => {
                indexer.fetch_sorted_cached_checkpoints(from, to).await
            }
            OutboxIndexers::Mock(indexer) => {
                indexer.fetch_sorted_cached_checkpoints(from, to).await
            }
            OutboxIndexers::Other(indexer) => {
                indexer.fetch_sorted_cached_checkpoints(from, to).await
            }
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
    async fn get_finalized_block_number(&self) -> Result<u32> {
        match self {
            InterchainGasPaymasterIndexers::Ethereum(indexer) => {
                indexer.get_finalized_block_number().await
            }
            InterchainGasPaymasterIndexers::Mock(indexer) => {
                indexer.get_finalized_block_number().await
            }
            InterchainGasPaymasterIndexers::Other(indexer) => {
                indexer.get_finalized_block_number().await
            }
        }
    }
}

#[async_trait]
impl InterchainGasPaymasterIndexer for InterchainGasPaymasterIndexers {
    async fn fetch_gas_payments(
        &self,
        from_block: u32,
        to_block: u32,
    ) -> Result<Vec<InterchainGasPaymentWithMeta>> {
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
