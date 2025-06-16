use std::ops::RangeInclusive;

use tendermint::abci::EventAttribute;
use tonic::async_trait;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster,
    InterchainGasPayment, LogMeta, SequenceAwareIndexer, H256, H512,
};

use crate::{ConnectionConf, KaspaEventIndexer, KaspaProvider, RpcProvider};

use super::ParsedEvent;

/// delivery indexer to check if a message was delivered
#[derive(Debug, Clone)]
pub struct KaspaInterchainGas {
    address: H256,
    domain: HyperlaneDomain,
    provider: KaspaProvider,
    native_token: String,
}

impl InterchainGasPaymaster for KaspaInterchainGas {}

impl KaspaInterchainGas {
    ///  Gas Payment Indexer
    pub fn new(
        provider: KaspaProvider,
        conf: &ConnectionConf,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(KaspaInterchainGas {
            address: locator.address,
            domain: locator.domain.clone(),
            provider,
        })
    }
}

// NOT IMPLEMENTED: must disable IGP indexing
impl KaspaEventIndexer<InterchainGasPayment> for KaspaInterchainGas {
    fn target_type() -> String {
        "".to_string()
    }

    fn provider(&self) -> &RpcProvider {
        self.provider.rpc() // TODO: Fix
    }

    #[instrument(err)]
    fn parse(&self, attrs: &[EventAttribute]) -> ChainResult<ParsedEvent<InterchainGasPayment>> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }

    fn address(&self) -> &H256 {
        &self.address
    }
}

impl HyperlaneChain for KaspaInterchainGas {
    // Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    // A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for KaspaInterchainGas {
    // Return the address of this contract
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for KaspaInterchainGas {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for KaspaInterchainGas {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        return ChainResult::Err(ChainCommunicationError::from_other_str("not implemented"));
    }
}
