use crate::RestProvider;
use hyperlane_core::{ChainCommunicationError, ChainResult, Indexed, Indexer, LogMeta, H256, H512};
use std::fmt::Debug;
use std::ops::RangeInclusive;
use tonic::async_trait;

#[derive(Debug, Eq, PartialEq)]
pub struct ParsedEvent<T: PartialEq> {
    contract_address: H256,
    event: T,
}

impl<T: PartialEq> ParsedEvent<T> {
    pub fn new(contract_address: H256, event: T) -> Self {
        Self {
            contract_address,
            event,
        }
    }

    pub fn inner(self) -> T {
        self.event
    }
}

#[async_trait]
pub trait KaspaEventIndexer<T: PartialEq + Send + Sync + 'static>: Indexer<T>
where
    Self: Clone + Send + Sync + 'static,
    Indexed<T>: From<T>,
{
    fn provider(&self) -> &RestProvider;

    fn address(&self) -> &H256;

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        _tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn fetch_logs_in_range(
        &self,
        _range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}
