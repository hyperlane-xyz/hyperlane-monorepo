#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::fmt::{Debug, self};
use std::sync::Arc;

use async_trait::async_trait;
use ethers::abi::AbiEncode;
use ethers::prelude::*;
use ethers_contract::builders::ContractCall;
use eyre::{eyre, Result};
use tracing::instrument;

use abacus_core::{
    AbacusAbi, AbacusChain, AbacusContract, AbacusMessage, ChainCommunicationError, Checkpoint,
    ContractLocator, Indexer, LogMeta, Mailbox, MailboxIndexer, RawAbacusMessage, TxCostEstimate,
    TxOutcome,
};

use crate::contracts::mailbox::{Mailbox as EthereumMailboxInternal, ProcessCall, MAILBOX_ABI};
use crate::tx::report_tx;

impl<M> fmt::Display for EthereumMailboxInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

#[derive(Debug)]
/// Struct that retrieves event data for an Ethereum mailbox
pub struct EthereumMailboxIndexer<M> {
    contract: EthereumMailboxInternal<M>,
    provider: Arc<M>,
    finality_blocks: u32,
}

impl<M> EthereumMailboxIndexer<M>
where
    M: Middleware,
{
    /// Create new EthereumMailboxIndexer
    pub fn new(provider: M, locator: &ContractLocator, finality_blocks: u32) -> Self {
        let contract = EthereumMailboxInternal::new(&locator.address, provider.clone());
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
    #[instrument(err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> Result<u32> {
        Ok(self
            .provider
            .get_block_number()
            .await?
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
    ) -> Result<Vec<(AbacusMessage, LogMeta)>> {
        let mut events: Vec<(AbacusMessage, LogMeta)> = self
            .contract
            .dispatch_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| (AbacusMessage::from(event.message.to_vec()), meta.into()))
            .collect();

        events.sort_by(|a, b| a.0.nonce.cmp(&b.0.nonce));
        Ok(events)
    }

    #[instrument(err, skip(self))]
    async fn fetch_delivered_messages(&self, from: u32, to: u32) -> Result<Vec<(H256, LogMeta)>> {
        Ok(self
            .contract
            .process_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| (H256::from(event.message_id), meta.into()))
            .collect())
    }
}

/// A reference to an Mailbox contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumMailbox<M> {
    contract: Arc<EthereumMailboxInternal<M>>,
    domain: u32,
    chain_name: String,
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
                &locator.address,
                provider.clone(),
            )),
            domain: locator.domain,
            chain_name: locator.chain_name.to_owned(),
            provider,
        }
    }

    /// Returns a ContractCall that processes the provided message.
    /// If the provided tx_gas_limit is None, gas estimation occurs.
    async fn process_contract_call(
        &self,
        message: &AbacusMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> Result<ContractCall<M, ()>, ChainCommunicationError> {
        let tx = self.contract.process(
            metadata.to_vec().into(),
            RawAbacusMessage::from(message).to_vec().into(),
        );

        let gas_limit = if let Some(gas_limit) = tx_gas_limit {
            gas_limit
        } else {
            tx.estimate_gas().await?.saturating_add(U256::from(100000))
        };
        Ok(tx.gas(gas_limit))
    }
}

impl<M> AbacusChain for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    fn chain_name(&self) -> &str {
        &self.chain_name
    }

    fn domain(&self) -> u32 {
        self.domain
    }
}

impl<M> AbacusContract for EthereumMailbox<M>
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
    #[instrument(err, ret, skip(self))]
    async fn count(&self) -> Result<u32, ChainCommunicationError> {
        Ok(self.contract.count().call().await?)
    }

    #[instrument(err, ret)]
    async fn delivered(&self, id: H256) -> Result<bool, ChainCommunicationError> {
        Ok(self.contract.delivered(id.into()).call().await?)
    }

    #[instrument(err, ret, skip(self))]
    async fn latest_checkpoint(
        &self,
        maybe_lag: Option<u64>,
    ) -> Result<Checkpoint, ChainCommunicationError> {
        let base_call = self.contract.latest_checkpoint();
        let call_with_lag = match maybe_lag {
            Some(lag) => {
                let tip = self
                    .provider
                    .get_block_number()
                    .await
                    .map_err(|x| ChainCommunicationError::CustomError(Box::new(x)))?
                    .as_u64();
                base_call.block(if lag > tip { 0 } else { tip - lag })
            }
            None => base_call,
        };
        let (root, index) = call_with_lag.call().await?;
        Ok(Checkpoint {
            mailbox_address: self.address(),
            mailbox_domain: self.domain,
            root: root.into(),
            index,
        })
    }

    #[instrument(err, ret, skip(self))]
    async fn default_ism(&self) -> Result<H256, ChainCommunicationError> {
        Ok(self.contract.default_ism().call().await?.into())
    }

    #[instrument(err, ret, skip(self))]
    async fn process(
        &self,
        message: &AbacusMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> Result<TxOutcome, ChainCommunicationError> {
        let contract_call = self
            .process_contract_call(message, metadata, tx_gas_limit)
            .await?;
        let receipt = report_tx(contract_call).await?;
        Ok(receipt.into())
    }

    #[instrument(err, ret, skip(self))]
    async fn process_estimate_costs(
        &self,
        message: &AbacusMessage,
        metadata: &[u8],
    ) -> Result<TxCostEstimate> {
        let contract_call = self.process_contract_call(message, metadata, None).await?;

        let gas_limit = contract_call
            .tx
            .gas()
            .ok_or_else(|| eyre!("Expected gas limit for process contract call"))?;
        let gas_price = self.provider.get_gas_price().await?;

        Ok(TxCostEstimate {
            gas_limit: *gas_limit,
            gas_price,
        })
    }

    fn process_calldata(&self, message: &AbacusMessage, metadata: &[u8]) -> Vec<u8> {
        let process_call = ProcessCall {
            message: RawAbacusMessage::from(message).to_vec().into(),
            metadata: metadata.to_vec().into(),
        };
        process_call.encode()
    }
}

pub struct EthereumMailboxAbi;

impl AbacusAbi for EthereumMailboxAbi {
    fn fn_map() -> HashMap<Selector, &'static str> {
        super::extract_fn_map(&MAILBOX_ABI)
    }
}
