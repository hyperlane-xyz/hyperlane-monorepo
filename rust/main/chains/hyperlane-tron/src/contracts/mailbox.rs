#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::Middleware;
use ethers_contract::builders::ContractCall;
use hyperlane_core::Metadata;
use tracing::instrument;

use hyperlane_core::{
    rpc_clients::call_and_retry_indefinitely, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Indexed, Indexer,
    LogMeta, Mailbox, RawHyperlaneMessage, ReorgPeriod, SequenceAwareIndexer, TxCostEstimate,
    TxOutcome, H256, H512, U256,
};

use crate::interfaces::i_mailbox::IMailbox as TronMailboxInternal;
use crate::interfaces::mailbox::DispatchFilter;
use crate::{fetch_raw_logs_and_meta, TronProvider};

#[derive(Debug, Clone)]
/// Struct that retrieves event data for a Tron mailbox
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

/// A reference to a Mailbox contract on some Tron chain
#[derive(Debug)]
pub struct TronMailbox {
    contract: Arc<TronMailboxInternal<TronProvider>>,
    domain: HyperlaneDomain,
    provider: Arc<TronProvider>,
}

impl TronMailbox {
    /// Create a reference to a mailbox at a specific Tron address on some
    /// chain
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        let provider = Arc::new(provider);
        Self {
            contract: Arc::new(TronMailboxInternal::new(locator.address, provider.clone())),
            domain: locator.domain.clone(),
            provider,
        }
    }

    fn contract_call(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_estimate: Option<U256>,
    ) -> ChainResult<ContractCall<TronProvider, ()>> {
        let mut tx = self.contract.process(
            metadata.to_vec().into(),
            RawHyperlaneMessage::from(message).to_vec().into(),
        );
        if let Some(gas_estimate) = tx_gas_estimate {
            tx = tx.gas(gas_estimate);
        }
        Ok(tx)
    }
}

impl HyperlaneChain for TronMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for TronMailbox {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl Mailbox for TronMailbox {
    /// Note: reorg_period is not used in this implementation
    /// because the Tron's view calls happen on the solidified node which is already finalized.
    #[instrument(skip(self))]
    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let nonce = self.contract.nonce().call().await?;
        Ok(nonce)
    }

    #[instrument(skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        Ok(self.contract.delivered(id.into()).call().await?)
    }

    #[instrument(skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        Ok(self.contract.default_ism().call().await?.into())
    }

    #[instrument(skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        Ok(self
            .contract
            .recipient_ism(recipient.into())
            .call()
            .await?
            .into())
    }

    #[instrument(skip(self, message, metadata))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let contract_call = self.contract_call(message, metadata, tx_gas_limit)?;
        self.provider.send_and_wait(&contract_call).await
    }

    #[instrument(skip(self))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
    ) -> ChainResult<TxCostEstimate> {
        let gas_limit = self
            .contract_call(message, metadata, None)?
            .estimate_gas()
            .await?;

        let gas_price: U256 = self.provider.get_gas_price().await?.into();

        Ok(TxCostEstimate {
            gas_limit: gas_limit.into(),
            gas_price: gas_price.try_into()?,
            l2_gas_limit: None,
        })
    }

    async fn process_calldata(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
    ) -> ChainResult<Vec<u8>> {
        let mut contract_call = self.contract.process(
            metadata.to_vec().into(),
            RawHyperlaneMessage::from(message).to_vec().into(),
        );
        contract_call.tx.set_chain_id(self.domain.id());
        let data = (contract_call.tx, contract_call.function);
        serde_json::to_vec(&data).map_err(Into::into)
    }

    fn delivered_calldata(&self, message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        let call = self.contract.delivered(message_id.into());

        let data = (call.tx, call.function);
        serde_json::to_vec(&data).map(Some).map_err(Into::into)
    }
}
