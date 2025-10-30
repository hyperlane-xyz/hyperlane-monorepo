use std::ops::RangeInclusive;

use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, LogMeta, SequenceAwareIndexer, H256,
    H512,
};
use snarkvm::prelude::Itertools;
use snarkvm::prelude::{TestnetV0, U128, U32};

use crate::{
    indexer::AleoIndexer, u128_to_hash, AleoMailboxStruct, AleoMessage, AleoProvider,
    ConnectionConf, HttpClient,
};

/// Aleo Delivery Indexer
#[derive(Debug, Clone)]
pub struct AleoDeliveryIndexer {
    provider: AleoProvider,
    address: H256,
    program: String,
    domain: HyperlaneDomain,
}

impl AleoDeliveryIndexer {
    /// Creates a new Delivery Indexer
    pub fn new(provider: AleoProvider, locator: &ContractLocator, conf: &ConnectionConf) -> Self {
        return Self {
            provider,
            address: locator.address,
            program: conf.mailbox_program.clone(),
            domain: locator.domain.clone(),
        };
    }
}

impl AleoIndexer for AleoDeliveryIndexer {
    const INDEX_MAPPING: &str = "process_event_index";
    const VALUE_MAPPING: &str = "process_events";

    type Type = [U128<TestnetV0>; 2];
    type AleoType = [U128<TestnetV0>; 2];

    fn get_client(&self) -> &AleoProvider {
        &self.provider
    }

    fn get_program(&self) -> &str {
        &self.program
    }
}

impl HyperlaneChain for AleoDeliveryIndexer {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for AleoDeliveryIndexer {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

// TODO: improve this code
#[async_trait]
impl Indexer<H256> for AleoDeliveryIndexer {
    /// Fetch list of logs between blocks `from` and `to`, inclusive.
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        let logs = AleoIndexer::fetch_logs_in_range(self, range).await?;
        Ok(logs
            .into_iter()
            .map(|(indexed, meta)| {
                let id = u128_to_hash(indexed.inner());
                let indexed = Indexed::new(id).with_sequence(indexed.sequence.unwrap());
                (indexed, meta)
            })
            .collect())
    }

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        AleoIndexer::get_finalized_block_number(self).await
    }

    /// Fetch list of logs emitted in a transaction with the given hash.
    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        let logs = AleoIndexer::fetch_logs_by_tx_hash(self, tx_hash).await?;
        Ok(logs
            .into_iter()
            .map(|(indexed, meta)| {
                let id = u128_to_hash(indexed.inner());
                let indexed = Indexed::new(id).with_sequence(indexed.sequence.unwrap());
                (indexed, meta)
            })
            .collect())
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for AleoDeliveryIndexer {
    /// Return the latest finalized sequence (if any) and block number
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let (mailbox, height) = self
            .provider
            .get_mapping_value_meta::<AleoMailboxStruct>(&self.program, "mailbox", "true")
            .await?;
        Ok((Some(*mailbox.process_count), height))
    }
}
