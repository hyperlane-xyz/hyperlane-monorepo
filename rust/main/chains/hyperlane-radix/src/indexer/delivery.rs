use std::ops::RangeInclusive;

use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, ContractLocator, Indexed, Indexer, LogMeta, SequenceAwareIndexer, H256, H512,
};

use crate::{encode_component_address, parse_process_id_event, ConnectionConf, RadixProvider};

/// Radix Delivery Indexer
#[derive(Debug)]
pub struct RadixDeliveryIndexer {
    provider: RadixProvider,
    address: String,
}

impl RadixDeliveryIndexer {
    /// New Delivery indexer instance
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
impl Indexer<H256> for RadixDeliveryIndexer {
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        let events = self
            .provider
            .fetch_logs_in_range(&self.address, range, parse_process_id_event)
            .await?;
        let result = events
            .into_iter()
            .map(|(event, meta)| {
                let id: H256 = event.message_id.into();
                let sequence = event.sequence;
                (Indexed::new(id).with_sequence(sequence), meta)
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
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        let events = self
            .provider
            .fetch_logs_by_hash(&self.address, &tx_hash, parse_process_id_event)
            .await?;
        let result = events
            .into_iter()
            .map(|(event, meta)| {
                let id: H256 = event.message_id.into();
                let sequence = event.sequence;
                (Indexed::new(id).with_sequence(sequence), meta)
            })
            .collect();
        Ok(result)
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for RadixDeliveryIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let (sequence, state_version): (u32, u64) = self
            .provider
            .call_method(&self.address, "processed", None, Vec::new())
            .await?;
        Ok((Some(sequence), state_version.try_into()?))
    }
}
