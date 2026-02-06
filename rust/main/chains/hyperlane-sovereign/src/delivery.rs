use std::str::FromStr;

use async_trait::async_trait;
use hyperlane_core::{ChainResult, H256};
use serde::Deserialize;

use crate::{types::TxEvent, SovereignProvider};

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

crate::indexer::impl_indexer_traits!(SovereignDeliveryIndexer, H256);
