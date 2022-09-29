#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::borrow::Borrow;
use std::collections::HashMap;
use std::{error::Error as StdError, sync::Arc};

use async_trait::async_trait;
use ethers::prelude::*;
use eyre::Result;
use tokio::sync::OnceCell;
use tracing::instrument;

use abacus_core::{
    AbacusAbi, AbacusCommon, AbacusContract, ChainCommunicationError, Checkpoint, ContractLocator,
    Indexer, LogMeta, Message, Outbox, OutboxIndexer, OutboxState, RawCommittedMessage, TxOutcome,
};

use crate::contracts::outbox::{Outbox as EthereumOutboxInternal, OUTBOX_ABI};
use crate::trait_builder::MakeableWithProvider;
use crate::tx::report_tx;

impl<M> std::fmt::Display for EthereumOutboxInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct OutboxIndexerBuilder {
    pub from_height: u32,
    pub chunk_size: u32,
    pub finality_blocks: u32,
}

impl MakeableWithProvider for OutboxIndexerBuilder {
    type Output = Box<dyn OutboxIndexer>;

    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumOutboxIndexer::new(
            Arc::new(provider),
            locator,
            self.from_height,
            self.chunk_size,
            self.finality_blocks,
        ))
    }
}

#[derive(Debug)]
/// Struct that retrieves event data for an Ethereum outbox
pub struct EthereumOutboxIndexer<M>
where
    M: Middleware,
{
    contract: Arc<EthereumOutboxInternal<M>>,
    provider: Arc<M>,
    #[allow(unused)]
    from_height: u32,
    #[allow(unused)]
    chunk_size: u32,
    finality_blocks: u32,
    outbox_domain: OnceCell<u32>,
}

impl<M> EthereumOutboxIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create new EthereumOutboxIndexer
    pub fn new(
        provider: Arc<M>,
        locator: &ContractLocator,
        from_height: u32,
        chunk_size: u32,
        finality_blocks: u32,
    ) -> Self {
        let contract = Arc::new(EthereumOutboxInternal::new(
            &locator.address,
            provider.clone(),
        ));
        Self {
            contract,
            provider,
            from_height,
            chunk_size,
            finality_blocks,
            outbox_domain: OnceCell::new(),
        }
    }

    /// Get the outbox domain, this will do a one-time init and will resolve
    /// immediately thereafter.
    async fn outbox_domain(&self) -> u32 {
        *self
            .outbox_domain
            .get_or_init(|| async {
                self.contract
                    .local_domain()
                    .call()
                    .await
                    .expect("Failed to query outbox domain")
            })
            .await
    }
}

#[async_trait]
impl<M> Indexer for EthereumOutboxIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
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
impl<M> OutboxIndexer for EthereumOutboxIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn fetch_sorted_messages(
        &self,
        from: u32,
        to: u32,
    ) -> Result<Vec<(RawCommittedMessage, LogMeta)>> {
        let mut events: Vec<(RawCommittedMessage, LogMeta)> = self
            .contract
            .dispatch_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| {
                (
                    RawCommittedMessage {
                        leaf_index: event.leaf_index.as_u32(),
                        message: event.message.to_vec(),
                    },
                    meta.into(),
                )
            })
            .collect();
        events.sort_by(|a, b| a.0.leaf_index.cmp(&b.0.leaf_index));
        Ok(events)
    }

    #[instrument(err, skip(self))]
    async fn fetch_sorted_cached_checkpoints(
        &self,
        from: u32,
        to: u32,
    ) -> Result<Vec<(Checkpoint, LogMeta)>> {
        let outbox_domain = self.outbox_domain().await;
        let mut events: Vec<(Checkpoint, LogMeta)> = self
            .contract
            .checkpoint_cached_filter()
            .from_block(from)
            .to_block(to)
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| {
                (
                    Checkpoint {
                        outbox_domain,
                        root: event.root.into(),
                        index: event.index.as_u32(),
                    },
                    meta.into(),
                )
            })
            .collect();
        events.sort_by(|a, b| a.1.cmp(&b.1));
        Ok(events)
    }
}

pub struct OutboxBuilder {}

impl MakeableWithProvider for OutboxBuilder {
    type Output = Box<dyn Outbox>;

    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumOutbox::new(Arc::new(provider), locator))
    }
}

/// A reference to an Outbox contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumOutbox<M>
where
    M: Middleware,
{
    contract: Arc<EthereumOutboxInternal<M>>,
    domain: u32,
    chain_name: String,
    provider: Arc<M>,
}

impl<M> EthereumOutbox<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a outbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumOutboxInternal::new(
                &locator.address,
                provider.clone(),
            )),
            domain: locator.domain,
            chain_name: locator.chain_name.to_owned(),
            provider,
        }
    }
}

impl<M> AbacusContract for EthereumOutbox<M>
where
    M: Middleware + 'static,
{
    fn chain_name(&self) -> &str {
        &self.chain_name
    }

    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> AbacusCommon for EthereumOutbox<M>
where
    M: Middleware + 'static,
{
    fn local_domain(&self) -> u32 {
        self.domain
    }

    #[tracing::instrument(err, skip(self))]
    async fn status(&self, txid: H256) -> Result<Option<TxOutcome>, ChainCommunicationError> {
        let receipt_opt = self
            .contract
            .client()
            .get_transaction_receipt(txid)
            .await
            .map_err(|e| Box::new(e) as Box<dyn StdError + Send + Sync>)?;

        Ok(receipt_opt.map(Into::into))
    }

    #[tracing::instrument(err, skip(self))]
    async fn validator_manager(&self) -> Result<H256, ChainCommunicationError> {
        Ok(self.contract.validator_manager().call().await?.into())
    }
}

#[async_trait]
impl<M> Outbox for EthereumOutbox<M>
where
    M: Middleware + 'static,
{
    #[tracing::instrument(err, skip(self))]
    async fn dispatch(&self, message: &Message) -> Result<TxOutcome, ChainCommunicationError> {
        let tx = self.contract.dispatch(
            message.destination,
            message.recipient.to_fixed_bytes(),
            message.body.clone().into(),
        );

        Ok(report_tx(tx).await?.into())
    }

    #[tracing::instrument(err, skip(self))]
    async fn state(&self) -> Result<OutboxState, ChainCommunicationError> {
        let state = self.contract.state().call().await?;
        Ok(OutboxState::try_from(state).expect("Invalid state received from contract"))
    }

    #[tracing::instrument(err, skip(self))]
    async fn count(&self) -> Result<u32, ChainCommunicationError> {
        Ok(self.contract.count().call().await?.as_u32())
    }

    #[tracing::instrument(err, skip(self))]
    async fn cache_checkpoint(&self) -> Result<TxOutcome, ChainCommunicationError> {
        let tx = self.contract.cache_checkpoint();

        Ok(report_tx(tx).await?.into())
    }

    #[tracing::instrument(err, skip(self))]
    async fn latest_cached_root(&self) -> Result<H256, ChainCommunicationError> {
        Ok(self.contract.latest_cached_root().call().await?.into())
    }

    #[tracing::instrument(err, skip(self))]
    async fn latest_cached_checkpoint(&self) -> Result<Checkpoint, ChainCommunicationError> {
        let (root, index) = self.contract.latest_cached_checkpoint().call().await?;
        Ok(Checkpoint {
            outbox_domain: self.domain,
            root: root.into(),
            index: index.as_u32(),
        })
    }

    #[tracing::instrument(err, skip(self))]
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
            outbox_domain: self.domain,
            root: root.into(),
            index: index.as_u32(),
        })
    }
}

pub struct EthereumOutboxAbi;

impl AbacusAbi for EthereumOutboxAbi {
    fn fn_map() -> HashMap<Selector, &'static str> {
        super::extract_fn_map(&OUTBOX_ABI)
    }
}
