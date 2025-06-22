use std::ops::RangeInclusive;

use tonic::async_trait;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneMessage, Indexed, Indexer,
    LogMeta, SequenceAwareIndexer, H256, H512,
};

use crate::{HyperlaneKaspaError, KaspaProvider, RestProvider};

use super::KaspaEventIndexer;

/// Dispatch indexer to check if a new hyperlane message was dispatched
#[derive(Debug, Clone)]
pub struct KaspaDispatch {
    provider: KaspaProvider,
    address: H256,
}

impl KaspaDispatch {
    ///  New Dispatch Indexer
    pub fn new(provider: KaspaProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(KaspaDispatch {
            provider,
            address: locator.address,
        })
    }
}

impl KaspaEventIndexer<HyperlaneMessage> for KaspaDispatch {
    fn provider(&self) -> &RestProvider {
        self.provider.rest()
    }

    fn address(&self) -> &H256 {
        &self.address
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for KaspaDispatch {
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for KaspaDispatch {
    #[instrument(err, skip(self), ret)]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}
