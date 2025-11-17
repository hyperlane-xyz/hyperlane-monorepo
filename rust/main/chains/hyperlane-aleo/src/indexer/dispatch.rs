use std::ops::RangeInclusive;

use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, LogMeta, SequenceAwareIndexer, H256,
};

use crate::{indexer::AleoIndexer, AleoMailboxStruct, AleoMessage, AleoProvider, ConnectionConf};

/// Aleo Dispatch Indexer
#[derive(Debug, Clone)]
pub struct AleoDispatchIndexer {
    provider: AleoProvider,
    address: H256,
    program: String,
    domain: HyperlaneDomain,
}

impl AleoDispatchIndexer {
    /// Creates a new Dispatch Indexer
    pub fn new(provider: AleoProvider, locator: &ContractLocator, conf: &ConnectionConf) -> Self {
        Self {
            provider,
            address: locator.address,
            program: conf.mailbox_program.clone(),
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneChain for AleoDispatchIndexer {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for AleoDispatchIndexer {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

impl AleoIndexer for AleoDispatchIndexer {
    const INDEX_MAPPING: &str = "dispatch_event_index";
    const VALUE_MAPPING: &str = "dispatch_events";

    type AleoType = AleoMessage;
    type Type = HyperlaneMessage;

    fn get_provider(&self) -> &AleoProvider {
        &self.provider
    }

    fn get_program(&self) -> &str {
        &self.program
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for AleoDispatchIndexer {
    /// Fetch list of logs between blocks `from` and `to`, inclusive.
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        AleoIndexer::fetch_logs_in_range(self, range).await
    }

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        AleoIndexer::get_finalized_block_number(self).await
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for AleoDispatchIndexer {
    /// Return the latest finalized sequence (if any) and block number
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let (mailbox, height) = self
            .provider
            .get_mapping_value_meta::<AleoMailboxStruct>(&self.program, "mailbox", "true")
            .await?;
        Ok((Some(mailbox.nonce), height))
    }
}
