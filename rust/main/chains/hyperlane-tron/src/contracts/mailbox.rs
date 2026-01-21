use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;

use hyperlane_core::{
    rpc_clients::call_and_retry_indefinitely, ChainResult, ContractLocator, HyperlaneMessage,
    Indexed, Indexer, LogMeta, SequenceAwareIndexer, H256, H512,
};

use crate::interfaces::i_mailbox::IMailbox as TronMailboxInternal;
use crate::interfaces::mailbox::DispatchFilter;
use crate::{fetch_raw_logs_and_meta, TronProvider};

#[derive(Debug, Clone)]
/// Struct that retrieves event data for an Tron mailbox
pub struct TronMailboxIndexer {
    contract: Arc<TronMailboxInternal<TronProvider>>,
    provider: Arc<TronProvider>,
}

impl TronMailboxIndexer {
    /// Create new TronMailboxIndexer
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        let provider = Arc::new(provider);
        let contract = Arc::new(TronMailboxInternal::new(locator.address, provider.clone()));
        Self { contract, provider }
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider.get_finalized_block_number().await
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for TronMailboxIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
    }

    /// Note: This call may return duplicates depending on the provider used
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let mut events: Vec<(Indexed<HyperlaneMessage>, LogMeta)> = self
            .contract
            .dispatch_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| {
                (
                    HyperlaneMessage::from(event.message.to_vec()).into(),
                    meta.into(),
                )
            })
            .collect();

        events.sort_by(|a, b| a.0.inner().nonce.cmp(&b.0.inner().nonce));
        Ok(events)
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let raw_logs_and_meta = call_and_retry_indefinitely(|| {
            let provider = self.provider.clone();
            let contract = self.contract.address();
            Box::pin(async move {
                fetch_raw_logs_and_meta::<DispatchFilter, _>(tx_hash, provider, contract).await
            })
        })
        .await;
        let logs = raw_logs_and_meta
            .into_iter()
            .map(|(log, log_meta)| {
                (
                    HyperlaneMessage::from(log.message.to_vec()).into(),
                    log_meta,
                )
            })
            .collect();
        Ok(logs)
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for TronMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(self).await?;
        let sequence = self.contract.nonce().block(u64::from(tip)).call().await?;
        Ok((Some(sequence), tip))
    }
}

#[async_trait]
impl Indexer<H256> for TronMailboxIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
    }

    /// Note: This call may return duplicates depending on the provider used
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        Ok(self
            .contract
            .process_id_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| (Indexed::new(H256::from(event.message_id)), meta.into()))
            .collect())
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for TronMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // A blanket implementation for this trait is fine for the TVM.
        let tip = Indexer::<H256>::get_finalized_block_number(self).await?;
        Ok((None, tip))
    }
}
