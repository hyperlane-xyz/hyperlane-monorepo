use super::KaspaEventIndexer;
use crate::{KaspaProvider, RestProvider};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Indexed, Indexer, LogMeta,
    SequenceAwareIndexer, H256, H512,
};
use std::ops::RangeInclusive;
use tonic::async_trait;
use tracing::instrument;

#[derive(Debug, Clone)]
pub struct KaspaDelivery {
    provider: KaspaProvider,
    address: H256,
}

impl KaspaDelivery {
    pub fn new(provider: KaspaProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(KaspaDelivery {
            provider,
            address: locator.address,
        })
    }
}

impl KaspaEventIndexer<H256> for KaspaDelivery {
    fn provider(&self) -> &RestProvider {
        self.provider.rest()
    }

    fn address(&self) -> &H256 {
        &self.address
    }
}

#[async_trait]
impl Indexer<H256> for KaspaDelivery {
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)]
    async fn fetch_logs_in_range(
        &self,
        _range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        _tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for KaspaDelivery {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}
