#![allow(missing_docs)]

use std::collections::HashMap;
use std::fmt::Display;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::*;
use eyre::Result;
use tracing::instrument;

use abacus_core::{
    AbacusAbi, AbacusContract, ContractLocator, Indexer, InterchainGasPaymaster,
    InterchainGasPaymasterIndexer, InterchainGasPayment, InterchainGasPaymentMeta,
    InterchainGasPaymentWithMeta,
};

use crate::contracts::interchain_gas_paymaster::{
    InterchainGasPaymaster as EthereumInterchainGasPaymasterInternal, INTERCHAINGASPAYMASTER_ABI,
};
use crate::trait_builder::MakeableWithProvider;

impl<M> Display for EthereumInterchainGasPaymasterInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct InterchainGasPaymasterIndexerBuilder {
    pub outbox_address: H160,
    pub from_height: u32,
    pub chunk_size: u32,
    pub finality_blocks: u32,
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
            self.outbox_address,
            self.from_height,
            self.chunk_size,
            self.finality_blocks,
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
    outbox_address: H160,
    #[allow(unused)]
    from_height: u32,
    #[allow(unused)]
    chunk_size: u32,
    finality_blocks: u32,
}

impl<M> EthereumInterchainGasPaymasterIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create new EthereumInterchainGasPaymasterIndexer
    pub fn new(
        provider: Arc<M>,
        locator: &ContractLocator,
        outbox_address: H160,
        from_height: u32,
        chunk_size: u32,
        finality_blocks: u32,
    ) -> Self {
        Self {
            contract: Arc::new(EthereumInterchainGasPaymasterInternal::new(
                &locator.address,
                provider.clone(),
            )),
            provider,
            outbox_address,
            from_height,
            chunk_size,
            finality_blocks,
        }
    }
}

#[async_trait]
impl<M> Indexer for EthereumInterchainGasPaymasterIndexer<M>
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
impl<M> InterchainGasPaymasterIndexer for EthereumInterchainGasPaymasterIndexer<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn fetch_gas_payments(
        &self,
        from_block: u32,
        to_block: u32,
    ) -> Result<Vec<InterchainGasPaymentWithMeta>> {
        let events = self
            .contract
            .gas_payment_filter()
            .topic1(self.outbox_address)
            .from_block(from_block)
            .to_block(to_block)
            .query_with_meta()
            .await?;

        Ok(events
            .into_iter()
            .map(|(log, log_meta)| InterchainGasPaymentWithMeta {
                payment: InterchainGasPayment {
                    leaf_index: log.leaf_index.as_u32(),
                    amount: log.amount,
                },
                meta: InterchainGasPaymentMeta {
                    transaction_hash: log_meta.transaction_hash,
                    log_index: log_meta.log_index,
                },
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
    chain_name: String,
    #[allow(dead_code)]
    domain: u32,
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
            chain_name: locator.chain_name.to_owned(),
            provider,
        }
    }
}

impl<M> AbacusContract for EthereumInterchainGasPaymaster<M>
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
impl<M> InterchainGasPaymaster for EthereumInterchainGasPaymaster<M> where M: Middleware + 'static {}

pub struct EthereumInterchainGasPaymasterAbi;

impl AbacusAbi for EthereumInterchainGasPaymasterAbi {
    fn fn_map() -> HashMap<Selector, &'static str> {
        super::extract_fn_map(&INTERCHAINGASPAYMASTER_ABI)
    }
}
