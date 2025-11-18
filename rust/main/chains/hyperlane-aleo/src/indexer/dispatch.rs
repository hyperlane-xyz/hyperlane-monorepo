use std::ops::RangeInclusive;

use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, LogMeta, SequenceAwareIndexer, H256,
};

use crate::{
    indexer::AleoIndexer,
    provider::{AleoClient, BaseHttpClient},
    AleoMailboxStruct, AleoMessage, AleoProvider, ConnectionConf,
};

/// Aleo Dispatch Indexer
#[derive(Debug, Clone)]
pub struct AleoDispatchIndexer<C: AleoClient = BaseHttpClient> {
    provider: AleoProvider<C>,
    address: H256,
    program: String,
    domain: HyperlaneDomain,
}

impl<C: AleoClient> AleoDispatchIndexer<C> {
    /// Creates a new Dispatch Indexer
    pub fn new(
        provider: AleoProvider<C>,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> Self {
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

impl<C: AleoClient> AleoIndexer for AleoDispatchIndexer<C> {
    const INDEX_MAPPING: &str = "dispatch_event_index";
    const VALUE_MAPPING: &str = "dispatch_events";

    type AleoType = AleoMessage;
    type Type = HyperlaneMessage;

    fn get_provider(&self) -> &AleoProvider<impl AleoClient> {
        &self.provider
    }

    fn get_program(&self) -> &str {
        &self.program
    }
}

#[async_trait]
impl<C: AleoClient> Indexer<HyperlaneMessage> for AleoDispatchIndexer<C> {
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
impl<C: AleoClient> SequenceAwareIndexer<HyperlaneMessage> for AleoDispatchIndexer<C> {
    /// Return the latest finalized sequence (if any) and block number
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let (mailbox, height) = self
            .provider
            .get_mapping_value_meta::<AleoMailboxStruct>(&self.program, "mailbox", "true")
            .await?;
        Ok((Some(mailbox.nonce), height))
    }
}
