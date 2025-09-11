use std::ops::RangeInclusive;

use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneMessage, Indexed, Indexer, LogMeta,
    SequenceAwareIndexer, H512,
};

use crate::{encode_component_address, parse_dispatch_event, ConnectionConf, RadixProvider};

/// Radix Dispatch Indexer
#[derive(Debug)]
pub struct RadixDispatchIndexer {
    provider: RadixProvider,
    address: String,
}

impl RadixDispatchIndexer {
    /// New Dispatch indexer instance
    pub fn new(
        provider: RadixProvider,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> ChainResult<Self> {
        let address = encode_component_address(&conf.network, locator.address)?;
        Ok(Self { address, provider })
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for RadixDispatchIndexer {
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let events = self
            .provider
            .fetch_logs_in_range(&self.address, range, parse_dispatch_event)
            .await?;
        let result = events
            .into_iter()
            .map(|(event, meta)| {
                let message: HyperlaneMessage = event.message.into();
                let sequence = event.sequence;
                (Indexed::new(message).with_sequence(sequence), meta)
            })
            .collect();
        Ok(result)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(self.provider.get_state_version(None).await?.try_into()?)
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let events = self
            .provider
            .fetch_logs_by_hash(&self.address, &tx_hash, parse_dispatch_event)
            .await?;
        let result = events
            .into_iter()
            .map(|(event, meta)| {
                let message: HyperlaneMessage = event.message.into();
                let sequence = event.sequence;
                (Indexed::new(message).with_sequence(sequence), meta)
            })
            .collect();
        Ok(result)
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for RadixDispatchIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let (sequence, state_version): (u32, u64) = self
            .provider
            .call_method(&self.address, "nonce", None, Vec::new())
            .await?;
        Ok((Some(sequence), state_version.try_into()?))
    }
}
