use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    SequenceAwareIndexer, H256, H512,
};

use crate::{encode_component_address, parse_gas_payment_event, ConnectionConf, RadixProvider};

/// Radix Interchain Gas Indexer
#[derive(Debug)]
pub struct RadixInterchainGasIndexer {
    provider: RadixProvider,
    address: String,
    address_256: H256,
    domain: HyperlaneDomain,
}

impl RadixInterchainGasIndexer {
    /// New Interchain Gas indexer instance
    pub fn new(
        provider: RadixProvider,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> ChainResult<Self> {
        let address = encode_component_address(&conf.network, locator.address)?;
        Ok(Self {
            address,
            address_256: locator.address,
            provider,
            domain: locator.domain.clone(),
        })
    }
}

impl HyperlaneChain for RadixInterchainGasIndexer {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for RadixInterchainGasIndexer {
    fn address(&self) -> H256 {
        self.address_256
    }
}

#[async_trait]
impl InterchainGasPaymaster for RadixInterchainGasIndexer {}

#[async_trait]
impl Indexer<InterchainGasPayment> for RadixInterchainGasIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: std::ops::RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        let events = self
            .provider
            .fetch_logs_in_range(&self.address, range, parse_gas_payment_event)
            .await?;
        let result = events
            .into_iter()
            .map(|(event, meta)| {
                let sequence = event.sequence;
                let gas_payment: InterchainGasPayment = event.into();
                (Indexed::new(gas_payment).with_sequence(sequence), meta)
            })
            .collect();

        Ok(result)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(self.provider.get_state_version(None).await?.try_into()?)
    }

    /// Fetch list of logs emitted in a transaction with the given hash.
    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        let events = self
            .provider
            .fetch_logs_by_hash(&self.address, &tx_hash, parse_gas_payment_event)
            .await?;
        let result = events
            .into_iter()
            .map(|(event, meta)| {
                let sequence = event.sequence;
                let gas_payment: InterchainGasPayment = event.into();
                (Indexed::new(gas_payment).with_sequence(sequence), meta)
            })
            .collect();
        Ok(result)
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for RadixInterchainGasIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let (sequence, state_version): (u32, u64) = self
            .provider
            .call_method(&self.address, "sequence", None, Vec::new())
            .await?;
        Ok((Some(sequence), state_version.try_into()?))
    }
}
