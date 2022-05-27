#![allow(missing_docs)]

use std::sync::Arc;

use async_trait::async_trait;
use ethers::contract::abigen;
use ethers::prelude::*;
use eyre::Result;
use tracing::instrument;

use abacus_core::{
    ContractLocator, Indexer, InterchainGasPaymaster, InterchainGasPaymasterIndexer,
    InterchainGasPayment,
};

use crate::trait_builder::MakeableWithProvider;

abigen!(
    EthereumInterchainGasPaymasterInternal,
    "./chains/abacus-ethereum/abis/InterchainGasPaymaster.abi.json"
);

impl<M> std::fmt::Display for EthereumInterchainGasPaymasterInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct InterchainGasPaymasterIndexerBuilder {
    pub from_height: u32,
    pub chunk_size: u32,
}

impl MakeableWithProvider for InterchainGasPaymasterIndexerBuilder {
    type Output = Box<dyn InterchainGasPaymasterIndexer>;

    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumInterchainGasPaymasterIndexer::new(
            Arc::new(provider),
            locator,
            self.from_height,
            self.chunk_size,
        ))
    }
}

#[derive(Debug)]
/// Struct that retrieves event data for an Ethereum InterchainGasPaymaster
pub struct EthereumInterchainGasPaymasterIndexer<M>
where
    M: Middleware,
{
    contract: Arc<EthereumInterchainGasPaymasterInternal<M>>,
    provider: Arc<M>,
    #[allow(unused)]
    from_height: u32,
    #[allow(unused)]
    chunk_size: u32,
}

impl<M> EthereumInterchainGasPaymasterIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create new EthereumInterchainGasPaymasterIndexer
    pub fn new(
        provider: Arc<M>,
        locator: &ContractLocator,
        from_height: u32,
        chunk_size: u32,
    ) -> Self {
        Self {
            contract: Arc::new(EthereumInterchainGasPaymasterInternal::new(
                &locator.address,
                provider.clone(),
            )),
            provider,
            from_height,
            chunk_size,
        }
    }
}

#[async_trait]
impl<M> Indexer for EthereumInterchainGasPaymasterIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn get_block_number(&self) -> Result<u32> {
        Ok(self.provider.get_block_number().await?.as_u32())
    }
}

#[async_trait]
impl<M> InterchainGasPaymasterIndexer for EthereumInterchainGasPaymasterIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn fetch_gas_payments(
        &self,
        from_block: u32,
        to_block: u32,
    ) -> Result<Vec<InterchainGasPayment>> {
        let events = self
            .contract
            .gas_payment_filter()
            .from_block(from_block)
            .to_block(to_block)
            .query()
            .await?;

        Ok(events
            .into_iter()
            .map(|e| InterchainGasPayment {
                leaf_index: e.leaf_index.as_u32(),
                amount: e.amount,
            })
            .collect())
    }
}

pub struct InterchainGasPaymasterBuilder {}

impl MakeableWithProvider for InterchainGasPaymasterBuilder {
    type Output = Box<dyn InterchainGasPaymaster>;

    fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumInterchainGasPaymaster::new(
            Arc::new(provider),
            locator,
        ))
    }
}

/// A reference to an InterchainGasPaymaster contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumInterchainGasPaymaster<M>
where
    M: Middleware,
{
    #[allow(dead_code)]
    contract: Arc<EthereumInterchainGasPaymasterInternal<M>>,
    #[allow(dead_code)]
    domain: u32,
    #[allow(dead_code)]
    name: String,
    #[allow(dead_code)]
    provider: Arc<M>,
}

impl<M> EthereumInterchainGasPaymaster<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a outbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumInterchainGasPaymasterInternal::new(
                &locator.address,
                provider.clone(),
            )),
            domain: locator.domain,
            name: locator.name.to_owned(),
            provider,
        }
    }
}

#[async_trait]
impl<M> InterchainGasPaymaster for EthereumInterchainGasPaymaster<M> where M: Middleware + 'static {}
