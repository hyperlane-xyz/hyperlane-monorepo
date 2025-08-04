use std::{ops::RangeInclusive, str::FromStr};

use async_trait::async_trait;
use hyperlane_core::{ChainResult, Indexed, Indexer, LogMeta, SequenceAwareIndexer, H256, H512};
use serde::Deserialize;

use crate::{indexer::SovIndexer, types::TxEvent, SovereignProvider};

/// Struct that retrieves delivery event data for a Sovereign Mailbox.
#[derive(Debug, Clone)]
pub struct SovereignDeliveryIndexer {
    provider: SovereignProvider,
}

impl SovereignDeliveryIndexer {
    /// Create a new `SovereignDeliveryIndexer`.
    pub fn new(provider: SovereignProvider) -> ChainResult<Self> {
        Ok(SovereignDeliveryIndexer { provider })
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ProcessEvent {
    process_id: ProcessEventInner,
}

#[derive(Debug, Clone, Deserialize)]
struct ProcessEventInner {
    id: String,
}

#[async_trait]
impl crate::indexer::SovIndexer<H256> for SovereignDeliveryIndexer {
    const EVENT_KEY: &'static str = "Mailbox/ProcessId";

    fn provider(&self) -> &SovereignProvider {
        &self.provider
    }

    async fn latest_sequence(&self, at_slot: Option<u64>) -> ChainResult<Option<u32>> {
        let sequence = self.provider().get_count(at_slot).await?;
        Ok(Some(sequence))
    }

    fn decode_event(&self, event: &TxEvent) -> ChainResult<H256> {
        let evt: ProcessEvent = serde_json::from_value(event.value.clone())?;
        Ok(H256::from_str(&evt.process_id.id)?)
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for SovereignDeliveryIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        <Self as SovIndexer<H256>>::latest_sequence_count_and_tip(self).await
    }
}

#[async_trait]
impl Indexer<H256> for SovereignDeliveryIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        <Self as SovIndexer<H256>>::fetch_logs_in_range(self, range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        <Self as SovIndexer<H256>>::get_finalized_block_number(self).await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        <Self as SovIndexer<H256>>::fetch_logs_by_tx_hash(self, tx_hash).await
    }
}

