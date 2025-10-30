use std::{ops::RangeInclusive, str::FromStr, sync::OnceLock};

use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster,
    InterchainGasPayment, LogMeta, SequenceAwareIndexer, H256, H512,
};
use snarkvm::prelude::{Address, FromBytes, Literal, Plaintext, TestnetV0, U32};

use crate::{
    indexer::AleoIndexer, AleoInterchainGasPaymaster, AleoMessage, AleoProvider, ConnectionConf,
    CurrentNetwork, GasPaymentEvent, HyperlaneAleoError,
};

/// Aleo InterchainGas Indexer
#[derive(Debug, Clone)]
pub struct AleoInterchainGasIndexer {
    client: AleoProvider,
    address: H256,
    program: String,
    aleo_address: Address<TestnetV0>,
    domain: HyperlaneDomain,
}

impl AleoInterchainGasIndexer {
    /// Creates a new IGP Indexer
    pub fn new(provider: AleoProvider, locator: &ContractLocator, conf: &ConnectionConf) -> Self {
        let aleo_address = Address::<TestnetV0>::from_bytes_le(locator.address.as_bytes()).unwrap();
        return Self {
            client: provider,
            address: locator.address,
            program: conf.hook_manager_program.clone(),
            aleo_address,
            domain: locator.domain.clone(),
        };
    }
}

impl HyperlaneChain for AleoInterchainGasIndexer {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.client.clone())
    }
}

impl HyperlaneContract for AleoInterchainGasIndexer {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

impl InterchainGasPaymaster for AleoInterchainGasIndexer {}

impl AleoIndexer for AleoInterchainGasIndexer {
    const INDEX_MAPPING: &str = "last_event_index";
    const VALUE_MAPPING: &str = "gas_payment_events";

    type AleoType = GasPaymentEvent;
    type Type = InterchainGasPayment;

    fn get_client(&self) -> &AleoProvider {
        &self.client
    }

    fn get_program(&self) -> &str {
        &self.program
    }

    /// TODO: maybe refactor this to a HookAleoIndexer
    /// Returns the lastest event index of that specific block
    async fn get_latest_event_index(&self, height: u32) -> ChainResult<u32> {
        // The lastest event index for hooks is composition of block_height & hook_address
        let last_event_index: U32<TestnetV0> = self
            .get_client()
            .get_mapping_value(
                self.get_program(),
                Self::INDEX_MAPPING,
                &format!(
                    "{{hook: {}, block_height: {}u32}}",
                    self.aleo_address, height
                ),
            )
            .await?;
        Ok(*last_event_index)
    }

    /// Returns the event value of a mapping
    fn get_mapping_key(&self, index: u32) -> ChainResult<Plaintext<CurrentNetwork>> {
        let str_value = format!("{{hook: {}, index: {}u32}}", self.aleo_address, index);
        Ok(Plaintext::from_str(&str_value).map_err(HyperlaneAleoError::from)?)
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for AleoInterchainGasIndexer {
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
impl SequenceAwareIndexer<InterchainGasPayment> for AleoInterchainGasIndexer {
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
        Ok((Some(*igp.count), height))
    }
}
