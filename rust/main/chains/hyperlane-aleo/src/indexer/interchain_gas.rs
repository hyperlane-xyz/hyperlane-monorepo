use std::{ops::RangeInclusive, str::FromStr};

use async_trait::async_trait;
use snarkvm::prelude::{Address, FromBytes, Network, Plaintext};

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    SequenceAwareIndexer, H256, H512,
};

use crate::{
    indexer::AleoIndexer,
    provider::{AleoClient, BaseHttpClient},
    AleoInterchainGasPaymaster, AleoProvider, ConnectionConf, CurrentNetwork, GasPaymentEvent,
    HookEventIndex, HyperlaneAleoError,
};

/// Aleo InterchainGas Indexer
#[derive(Debug, Clone)]
pub struct AleoInterchainGasIndexer<C: AleoClient = BaseHttpClient> {
    client: AleoProvider<C>,
    address: H256,
    program: String,
    aleo_address: Address<CurrentNetwork>,
    domain: HyperlaneDomain,
}

impl<C: AleoClient> AleoInterchainGasIndexer<C> {
    /// Creates a new IGP Indexer
    pub fn new(
        provider: AleoProvider<C>,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> ChainResult<Self> {
        let aleo_address = Address::<CurrentNetwork>::from_bytes_le(locator.address.as_bytes())
            .map_err(HyperlaneAleoError::from)?;
        Ok(Self {
            client: provider,
            address: locator.address,
            program: conf.hook_manager_program.clone(),
            aleo_address,
            domain: locator.domain.clone(),
        })
    }
}

impl<C: AleoClient> HyperlaneChain for AleoInterchainGasIndexer<C> {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.client.clone())
    }
}

impl<C: AleoClient> HyperlaneContract for AleoInterchainGasIndexer<C> {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

impl<C: AleoClient> InterchainGasPaymaster for AleoInterchainGasIndexer<C> {}

impl<C: AleoClient> AleoIndexer for AleoInterchainGasIndexer<C> {
    const INDEX_MAPPING: &str = "last_event_index";
    const VALUE_MAPPING: &str = "gas_payment_events";

    type AleoType = GasPaymentEvent;
    type Type = InterchainGasPayment;

    fn get_provider(&self) -> &AleoProvider<impl AleoClient> {
        &self.client
    }

    fn get_program(&self) -> &str {
        &self.program
    }

    /// Returns the latest event index of that specific block
    async fn get_latest_event_index(&self, height: u32) -> ChainResult<Option<u32>> {
        let key = HookEventIndex {
            hook: self.aleo_address,
            block_height: height,
        };
        // The latest event index for hooks is composition of block_height & hook_address
        let last_event_index = self
            .get_provider()
            .get_mapping_value(self.get_program(), Self::INDEX_MAPPING, &key)
            .await?;
        Ok(last_event_index)
    }

    /// Returns the event value of a mapping
    fn get_mapping_key<N: Network>(&self, index: u32) -> ChainResult<Plaintext<N>> {
        let str_value = format!("{{hook: {}, index: {}u32}}", self.aleo_address, index);
        Ok(Plaintext::from_str(&str_value).map_err(HyperlaneAleoError::from)?)
    }
}

#[async_trait]
impl<C: AleoClient> Indexer<InterchainGasPayment> for AleoInterchainGasIndexer<C> {
    /// Fetch list of logs between blocks `from` and `to`, inclusive.
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        AleoIndexer::fetch_logs_in_range(self, range).await
    }

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        AleoIndexer::get_finalized_block_number(self).await
    }

    /// Fetch list of logs emitted in a transaction with the given hash.
    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        AleoIndexer::fetch_logs_by_tx_hash(self, tx_hash).await
    }
}

#[async_trait]
impl<C: AleoClient> SequenceAwareIndexer<InterchainGasPayment> for AleoInterchainGasIndexer<C> {
    /// Return the latest finalized sequence (if any) and block number
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let (igp, height) = self
            .client
            .get_mapping_value_meta::<AleoInterchainGasPaymaster>(
                &self.program,
                "igps",
                &self.aleo_address.to_string(),
            )
            .await?;
        Ok((Some(igp.count), height))
    }
}
