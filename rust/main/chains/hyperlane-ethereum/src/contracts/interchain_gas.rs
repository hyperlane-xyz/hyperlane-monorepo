#![allow(missing_docs)]

use std::collections::HashMap;
use std::fmt::Display;
use std::ops::RangeInclusive;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::Middleware;
use hyperlane_core::rpc_clients::call_and_retry_indefinitely;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    SequenceAwareIndexer, H160, H256, H512,
};

use super::utils::{fetch_raw_logs_and_meta, get_finalized_block_number};
use crate::interfaces::i_interchain_gas_paymaster::{
    GasPaymentFilter, IInterchainGasPaymaster as EthereumInterchainGasPaymasterInternal,
    IINTERCHAINGASPAYMASTER_ABI,
};
use crate::{BuildableWithProvider, ConnectionConf, EthereumProvider, EthereumReorgPeriod};

impl<M> Display for EthereumInterchainGasPaymasterInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct InterchainGasPaymasterIndexerBuilder {
    pub mailbox_address: H160,
    pub reorg_period: EthereumReorgPeriod,
}

#[async_trait]
impl BuildableWithProvider for InterchainGasPaymasterIndexerBuilder {
    type Output = Box<dyn SequenceAwareIndexer<InterchainGasPayment>>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumInterchainGasPaymasterIndexer::new(
            Arc::new(provider),
            locator,
            self.reorg_period,
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
    reorg_period: EthereumReorgPeriod,
}

impl<M> EthereumInterchainGasPaymasterIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create new EthereumInterchainGasPaymasterIndexer
    pub fn new(
        provider: Arc<M>,
        locator: &ContractLocator,
        reorg_period: EthereumReorgPeriod,
    ) -> Self {
        Self {
            contract: Arc::new(EthereumInterchainGasPaymasterInternal::new(
                locator.address,
                provider.clone(),
            )),
            provider,
            reorg_period,
        }
    }
}

#[async_trait]
impl<M> Indexer<InterchainGasPayment> for EthereumInterchainGasPaymasterIndexer<M>
where
    M: Middleware + 'static,
{
    /// Note: This call may return duplicates depending on the provider used
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        let events = self
            .contract
            .gas_payment_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?;

        Ok(events
            .into_iter()
            .map(|(log, log_meta)| {
                (
                    Indexed::new(InterchainGasPayment {
                        message_id: H256::from(log.message_id),
                        destination: log.destination_domain,
                        payment: log.payment.into(),
                        gas_amount: log.gas_amount.into(),
                    }),
                    log_meta.into(),
                )
            })
            .collect())
    }

    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        get_finalized_block_number(&self.provider, &self.reorg_period).await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        let raw_logs_and_meta = call_and_retry_indefinitely(|| {
            let provider = self.provider.clone();
            let contract = self.contract.address();
            Box::pin(async move {
                fetch_raw_logs_and_meta::<GasPaymentFilter, M>(tx_hash, provider, contract).await
            })
        })
        .await;

        let logs = raw_logs_and_meta
            .into_iter()
            .map(|(log, log_meta)| {
                (
                    Indexed::new(InterchainGasPayment {
                        message_id: H256::from(log.message_id),
                        destination: log.destination_domain,
                        payment: log.payment.into(),
                        gas_amount: log.gas_amount.into(),
                    }),
                    log_meta,
                )
            })
            .collect();
        Ok(logs)
    }
}

#[async_trait]
impl<M> SequenceAwareIndexer<InterchainGasPayment> for EthereumInterchainGasPaymasterIndexer<M>
where
    M: Middleware + 'static,
{
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // The InterchainGasPaymasterIndexerBuilder must return a `SequenceAwareIndexer` type.
        // It's fine if only a blanket implementation is provided for EVM chains, since their
        // indexing only uses the `Index` trait, which is a supertrait of `SequenceAwareIndexer`.
        // TODO: if `SequenceAwareIndexer` turns out to not depend on `Indexer` at all, then the supertrait
        // dependency could be removed, even if the builder would still need to return a type that is both
        // ``SequenceAwareIndexer` and `Indexer`.
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}

pub struct InterchainGasPaymasterBuilder {}

#[async_trait]
impl BuildableWithProvider for InterchainGasPaymasterBuilder {
    type Output = Box<dyn InterchainGasPaymaster>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
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
    contract: Arc<EthereumInterchainGasPaymasterInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumInterchainGasPaymaster<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumInterchainGasPaymasterInternal::new(
                locator.address,
                provider,
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl<M> HyperlaneChain for EthereumInterchainGasPaymaster<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.contract.client(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumInterchainGasPaymaster<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> InterchainGasPaymaster for EthereumInterchainGasPaymaster<M> where M: Middleware + 'static {}

pub struct EthereumInterchainGasPaymasterAbi;

impl HyperlaneAbi for EthereumInterchainGasPaymasterAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&IINTERCHAINGASPAYMASTER_ABI)
    }
}
