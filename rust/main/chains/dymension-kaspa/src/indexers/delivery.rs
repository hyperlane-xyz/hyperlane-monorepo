use std::ops::RangeInclusive;

use hyperlane_cosmos_rs::{hyperlane::core::v1::EventProcess, prost::Name};
use tonic::async_trait;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Indexed, Indexer, LogMeta,
    SequenceAwareIndexer, H256, H512,
};

use crate::{HyperlaneKaspaError, KaspaProvider, RestProvider};

use super::KaspaEventIndexer;

/// delivery indexer to check if a message was delivered
#[derive(Debug, Clone)]
pub struct KaspaDelivery {
    provider: KaspaProvider,
    address: H256,
}

impl KaspaDelivery {
    ///  New Delivery Indexer
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
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    // used for the tx id indexer task
    //  can disable by setting this none https://github.com/dymensionxyz/hyperlane-monorepo/blob/5f2136acc6a8e12adaac9e053811e9c33623d01e/rust/main/hyperlane-base/src/contract_sync/mod.rs#L379
    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
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
