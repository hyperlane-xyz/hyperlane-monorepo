use std::ops::RangeInclusive;

use hyperlane_cosmos_rs::{hyperlane::core::post_dispatch::v1::EventGasPayment, prost::Name};
use tonic::async_trait;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster,
    InterchainGasPayment, LogMeta, SequenceAwareIndexer, H256, H512,
};

use crate::{ConnectionConf, HyperlaneKaspaError, KaspaEventIndexer, KaspaProvider, RestProvider};

/// delivery indexer to check if a message was delivered
#[derive(Debug, Clone)]
pub struct KaspaGas {
    address: H256,
    domain: HyperlaneDomain,
    provider: KaspaProvider,
}

impl InterchainGasPaymaster for KaspaGas {}

impl KaspaGas {
    ///  Gas Payment Indexer
    pub fn new(
        provider: KaspaProvider,
        conf: &ConnectionConf,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(KaspaGas {
            address: locator.address,
            domain: locator.domain.clone(),
            provider,
        })
    }
}

impl KaspaEventIndexer<InterchainGasPayment> for KaspaGas {
    fn provider(&self) -> &RestProvider {
        self.provider.rest()
    }

    fn address(&self) -> &H256 {
        &self.address
    }
}

impl HyperlaneChain for KaspaGas {
    // Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    // A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for KaspaGas {
    // Return the address of this contract
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for KaspaGas {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for KaspaGas {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}
