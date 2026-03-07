use std::sync::Arc;

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::{
    HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage, HyperlaneWatermarkedLogStore, Indexed,
    LogMeta, H256,
};
use prometheus::IntCounterVec;

use crate::db::{BlockCursor, CursorKind, ScraperDb, StorableRawMessageDispatch};

/// Label for tip-stage raw dispatch metrics.
const RAW_MESSAGE_DISPATCH_TIP_LABEL: &str = "raw_message_dispatch_tip";

/// Message store for tip-stage scraping.
///
/// This intentionally only stores raw dispatch rows because enriched tables are
/// finalized-state oriented and not reorg-resilient.
///
/// Reorg behavior:
/// - if a message reappears at a different block/tx, upsert updates the existing row
/// - if a message is dropped by reorg and never re-included, a stale raw row can remain
///
/// Finalized/enriched tables remain the authoritative source of truth.
#[derive(Clone, Debug)]
pub struct TipMessageStore {
    db: ScraperDb,
    domain: HyperlaneDomain,
    mailbox_address: H256,
    cursor: Arc<BlockCursor>,
    stored_events_metric: Option<IntCounterVec>,
}

impl TipMessageStore {
    pub async fn new(
        db: ScraperDb,
        domain: HyperlaneDomain,
        mailbox_address: H256,
        default_height: u64,
        stored_events_metric: Option<IntCounterVec>,
    ) -> Result<Self> {
        let cursor = Arc::new(
            db.block_cursor(domain.id(), default_height, CursorKind::Tip)
                .await?,
        );
        Ok(Self {
            db,
            domain,
            mailbox_address,
            cursor,
            stored_events_metric,
        })
    }
}

#[async_trait]
impl HyperlaneLogStore<HyperlaneMessage> for TipMessageStore {
    async fn store_logs(&self, messages: &[(Indexed<HyperlaneMessage>, LogMeta)]) -> Result<u32> {
        if messages.is_empty() {
            return Ok(0);
        }

        let raw_messages = messages
            .iter()
            .map(|(message, meta)| StorableRawMessageDispatch {
                msg: message.inner(),
                meta,
            });
        let stored = self
            .db
            .store_raw_message_dispatches(self.domain.id(), &self.mailbox_address, raw_messages)
            .await?;

        if let Some(metric) = self.stored_events_metric.as_ref() {
            metric
                .with_label_values(&[RAW_MESSAGE_DISPATCH_TIP_LABEL, self.domain.name()])
                .inc_by(stored);
        }

        Ok(stored as u32)
    }
}

#[async_trait]
impl HyperlaneWatermarkedLogStore<HyperlaneMessage> for TipMessageStore {
    async fn retrieve_high_watermark(&self) -> Result<Option<u32>> {
        Ok(Some(self.cursor.height().await.try_into()?))
    }

    async fn store_high_watermark(&self, block_number: u32) -> Result<()> {
        self.cursor.update(block_number.into()).await;
        Ok(())
    }
}
