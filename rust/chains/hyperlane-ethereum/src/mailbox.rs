#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::num::NonZeroU64;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::abi::AbiEncode;
use ethers::prelude::Middleware;
use ethers::types::Eip1559TransactionRequest;
use ethers_contract::builders::ContractCall;
use tracing::{instrument};

use hyperlane_core::{
    utils::fmt_bytes, ChainCommunicationError, ChainResult, Checkpoint, ContractLocator,
    HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProtocolError, HyperlaneProvider, Indexer, LogMeta, Mailbox, MailboxIndexer,
    RawHyperlaneMessage, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::contracts::mailbox::{Mailbox as EthereumMailboxInternal, ProcessCall, MAILBOX_ABI};
use crate::trait_builder::BuildableWithProvider;
use crate::tx::report_tx;
use crate::EthereumProvider;

impl<M> std::fmt::Display for EthereumMailboxInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

pub struct MailboxIndexerBuilder {
    pub finality_blocks: u32,
}

#[async_trait]
impl BuildableWithProvider for MailboxIndexerBuilder {
    type Output = Box<dyn MailboxIndexer>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMailboxIndexer::new(
            Arc::new(provider),
            locator,
            self.finality_blocks,
        ))
    }
}

#[derive(Debug)]
/// Struct that retrieves event data for an Ethereum mailbox
pub struct EthereumMailboxIndexer<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMailboxInternal<M>>,
    provider: Arc<M>,
    finality_blocks: u32,
}

impl<M> EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create new EthereumMailboxIndexer
    pub fn new(provider: Arc<M>, locator: &ContractLocator, finality_blocks: u32) -> Self {
        let contract = Arc::new(EthereumMailboxInternal::new(
            locator.address,
            provider.clone(),
        ));
        Self {
            contract,
            provider,
            finality_blocks,
        }
    }
}

#[async_trait]
impl<M> Indexer for EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(self
            .provider
            .get_block_number()
            .await
            .map_err(ChainCommunicationError::from_other)?
            .as_u32()
            .saturating_sub(self.finality_blocks))
    }
}

#[async_trait]
impl<M> MailboxIndexer for EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn fetch_sorted_messages(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {
        let mut events: Vec<(HyperlaneMessage, LogMeta)> = self
            .contract
            .dispatch_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| (HyperlaneMessage::from(event.message.to_vec()), meta.into()))
            .collect();

        events.sort_by(|a, b| a.0.nonce.cmp(&b.0.nonce));
        Ok(events)
    }

    #[instrument(err, skip(self))]
    async fn fetch_delivered_messages(
        &self,
        from: u32,
        to: u32,
    ) -> ChainResult<Vec<(H256, LogMeta)>> {
        Ok(self
            .contract
            .process_id_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| (H256::from(event.message_id), meta.into()))
            .collect())
    }
}

pub struct MailboxBuilder {}

#[async_trait]
impl BuildableWithProvider for MailboxBuilder {
    type Output = Box<dyn Mailbox>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMailbox::new(Arc::new(provider), locator))
    }
}

/// A reference to a Mailbox contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumMailbox<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMailboxInternal<M>>,
    domain: HyperlaneDomain,
    provider: Arc<M>,
}

impl<M> EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumMailboxInternal::new(
                locator.address,
                provider.clone(),
            )),
            domain: locator.domain.clone(),
            provider,
        }
    }

    /// Returns a ContractCall that processes the provided message.
    /// If the provided tx_gas_limit is None, gas estimation occurs.
    async fn process_contract_call(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<ContractCall<M, ()>> {
        let tx = self.contract.process(
            metadata.to_vec().into(),
            RawHyperlaneMessage::from(message).to_vec().into(),
        );
        let gas_limit = if let Some(gas_limit) = tx_gas_limit {
            gas_limit
        } else {
            tx.estimate_gas().await?.saturating_add(U256::from(100000))
        };
        if let Ok((max_fee, max_priority_fee)) = self.provider.estimate_eip1559_fees(None).await {
            // Is EIP 1559 chain
            let mut request = Eip1559TransactionRequest::new();
            if let Some(from) = tx.tx.from() {
                request = request.from(*from);
            }
            if let Some(to) = tx.tx.to() {
                request = request.to(to.clone());
            }
            if let Some(data) = tx.tx.data() {
                request = request.data(data.clone());
            }
            if let Some(value) = tx.tx.value() {
                request = request.value(*value);
            }
            request = request.max_fee_per_gas(max_fee);
            request = request.max_priority_fee_per_gas(max_priority_fee);
            let mut eip_1559_tx = tx.clone();
            eip_1559_tx.tx =
                ethers::types::transaction::eip2718::TypedTransaction::Eip1559(request.clone());
            Ok(eip_1559_tx.gas(gas_limit))
        } else {
            // Is not EIP 1559 chain
            Ok(tx.gas(gas_limit))
        }
    }
}

impl<M> HyperlaneChain for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.provider.clone(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> Mailbox for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn count(&self) -> ChainResult<u32> {
        Ok(self.contract.count().call().await?)
    }

    #[instrument(err, ret)]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        Ok(self.contract.delivered(id.into()).call().await?)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn latest_checkpoint(&self, maybe_lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        let base_call = self.contract.latest_checkpoint();
        let call_with_lag = match maybe_lag {
            Some(lag) => {
                let tip = self
                    .provider
                    .get_block_number()
                    .await
                    .map_err(ChainCommunicationError::from_other)?
                    .as_u64();
                base_call.block(tip.saturating_sub(lag.get()))
            }
            None => base_call,
        };
        let (root, index) = call_with_lag.call().await?;
        Ok(Checkpoint {
            mailbox_address: self.address(),
            mailbox_domain: self.domain.id(),
            root: root.into(),
            index,
        })
    }

    #[instrument(err, ret, skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        Ok(self.contract.default_ism().call().await?.into())
    }

    #[instrument(err, ret, skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        Ok(self
            .contract
            .recipient_ism(recipient.into())
            .call()
            .await?
            .into())
    }

    #[instrument(err, ret, skip(self), fields(metadata=%fmt_bytes(metadata)))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let contract_call = self
            .process_contract_call(message, metadata, tx_gas_limit)
            .await?;
        let receipt = report_tx(contract_call).await?;
        Ok(receipt.into())
    }

    #[instrument(err, ret, skip(self), fields(msg=%message, metadata=%fmt_bytes(metadata)))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        let contract_call = self.process_contract_call(message, metadata, None).await?;
        let gas_limit = contract_call
            .tx
            .gas()
            .ok_or(HyperlaneProtocolError::ProcessGasLimitRequired)?;
        let gas_price = self
            .provider
            .get_gas_price()
            .await
            .map_err(ChainCommunicationError::from_other)?;

        Ok(TxCostEstimate {
            gas_limit: *gas_limit,
            gas_price,
        })
    }

    fn process_calldata(&self, message: &HyperlaneMessage, metadata: &[u8]) -> Vec<u8> {
        let process_call = ProcessCall {
            message: RawHyperlaneMessage::from(message).to_vec().into(),
            metadata: metadata.to_vec().into(),
        };

        AbiEncode::encode(process_call)
    }
}

pub struct EthereumMailboxAbi;

impl HyperlaneAbi for EthereumMailboxAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        super::extract_fn_map(&MAILBOX_ABI)
    }
}
