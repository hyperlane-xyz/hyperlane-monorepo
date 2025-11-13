use std::ops::RangeInclusive;

use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, LogMeta, SequenceAwareIndexer, H256, H512,
};

use crate::utils::aleo_hash_to_h256;
use crate::AleoHash;
use crate::{indexer::AleoIndexer, AleoMailboxStruct, AleoProvider, ConnectionConf};

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
        Self {
            provider,
            address: locator.address,
            program: conf.mailbox_program.clone(),
            domain: locator.domain.clone(),
        }
    }
}

impl AleoIndexer for AleoDeliveryIndexer {
    const INDEX_MAPPING: &str = "process_event_index";
    const VALUE_MAPPING: &str = "process_events";

    type Type = AleoHash;
    type AleoType = AleoHash;

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
                let id = aleo_hash_to_h256(indexed.inner());
                let mut update = Indexed::new(id);
                if let Some(sequence) = indexed.sequence {
                    update = update.with_sequence(sequence);
                };
                (update, meta)
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
                let id = aleo_hash_to_h256(indexed.inner());
                let mut update = Indexed::new(id);
                if let Some(sequence) = indexed.sequence {
                    update = update.with_sequence(sequence);
                };
                (update, meta)
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
        Ok((Some(mailbox.process_count), height))
    }
}
