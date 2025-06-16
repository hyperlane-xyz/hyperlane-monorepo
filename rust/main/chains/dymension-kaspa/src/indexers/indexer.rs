use std::fmt::Debug;
use std::ops::RangeInclusive;

use tonic::async_trait;

use hyperlane_core::{ChainCommunicationError, ChainResult, Indexed, Indexer, LogMeta, H256, H512};

use crate::RpcProvider;

#[derive(Debug, Eq, PartialEq)]
/// An event parsed from the RPC response.
pub struct ParsedEvent<T: PartialEq> {
    contract_address: H256,
    event: T,
}

impl<T: PartialEq> ParsedEvent<T> {
    /// Create a new ParsedEvent.
    pub fn new(contract_address: H256, event: T) -> Self {
        Self {
            contract_address,
            event,
        }
    }

    /// Get the inner event
    pub fn inner(self) -> T {
        self.event
    }
}

#[async_trait]
/// Event indexer that parses and filters events based on the target type & parse function.
pub trait KaspaEventIndexer<T: PartialEq + Send + Sync + 'static>: Indexer<T>
where
    Self: Clone + Send + Sync + 'static,
    Indexed<T>: From<T>,
{
    /// Cosmos provider
    fn provider(&self) -> &RpcProvider;

    /// address for the given module that will be indexed
    fn address(&self) -> &H256;

    /// Current block height
    ///
    /// used by the indexer struct
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    /// Fetch list of logs between blocks `from` and `to`, inclusive.
    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    /// Fetch list of logs emitted in a transaction with the given hash.
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}
