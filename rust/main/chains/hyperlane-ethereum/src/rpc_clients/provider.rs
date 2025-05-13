use std::fmt::Debug;
use std::future::Future;
use std::marker::PhantomData;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use derive_new::new;
use ethers::types::{Block, H256 as EthersH256};
use ethers::{prelude::Middleware, types::TransactionReceipt};
use ethers_contract::builders::ContractCall;
use ethers_core::abi::Function;
use ethers_core::types::transaction::eip2718::TypedTransaction;
use ethers_core::types::BlockId;
use ethers_core::{abi::Address, types::BlockNumber};
use hyperlane_core::{ethers_core_types, ChainInfo, HyperlaneCustomErrorWrapper, H512, U256};
use tokio::time::sleep;
use tracing::instrument;

use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, TxnInfo, TxnReceiptInfo, H256,
};

use crate::{
    get_finalized_block_number, BuildableWithProvider, ConnectionConf, EthereumReorgPeriod,
};

/// Connection to an ethereum provider. Useful for querying information about
/// the blockchain.
#[derive(Debug, Clone, new)]
pub struct EthereumProvider<M> {
    provider: Arc<M>,
    domain: HyperlaneDomain,
}

impl<M> EthereumProvider<M> {
    /// Create a ContractCall object for a given transaction and function.
    pub fn build_contract_call<D>(
        &self,
        tx: TypedTransaction,
        function: Function,
    ) -> ContractCall<M, D> {
        ContractCall {
            tx,
            function,
            block: None,
            client: self.provider.clone(),
            datatype: PhantomData::<D>,
        }
    }
}

impl<M> HyperlaneChain for EthereumProvider<M>
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

/// Methods of provider which are used in submitter
#[async_trait]
pub trait EvmProviderForSubmitter: Send + Sync {
    /// Get the transaction receipt for a given transaction hash
    async fn get_transaction_receipt(
        &self,
        transaction_hash: H256,
    ) -> ChainResult<Option<TransactionReceipt>>;

    /// Get the finalized block number
    async fn get_finalized_block_number(
        &self,
        reorg_period: &EthereumReorgPeriod,
    ) -> ChainResult<u32>;

    /// Get the block for a given block number
    async fn get_block(&self, block_number: BlockNumber) -> ChainResult<Option<Block<EthersH256>>>;

    /// Estimate the gas limit for a transaction
    async fn estimate_gas_limit(
        &self,
        tx: &TypedTransaction,
        function: &Function,
    ) -> Result<U256, ChainCommunicationError>;

    /// Send transaction into blockchain
    async fn send(&self, tx: &TypedTransaction, function: &Function) -> ChainResult<H256>;

    /// Read-only call into blockchain which returns a boolean
    async fn check(&self, tx: &TypedTransaction, function: &Function) -> ChainResult<bool>;

    /// Get the next nonce to use for a given address (using the finalized block)
    async fn get_next_nonce_on_finalized_block(&self, address: &Address) -> ChainResult<U256>;
}

#[async_trait]
impl<M> EvmProviderForSubmitter for EthereumProvider<M>
where
    M: Middleware + 'static,
{
    async fn get_transaction_receipt(
        &self,
        transaction_hash: H256,
    ) -> ChainResult<Option<TransactionReceipt>> {
        let receipt = self
            .provider
            .get_transaction_receipt(transaction_hash)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        Ok(receipt)
    }

    async fn get_finalized_block_number(
        &self,
        reorg_period: &EthereumReorgPeriod,
    ) -> ChainResult<u32> {
        get_finalized_block_number(&*self.provider, reorg_period).await
    }

    async fn get_block(&self, block_number: BlockNumber) -> ChainResult<Option<Block<EthersH256>>> {
        let block = self
            .provider
            .get_block(block_number)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        Ok(block)
    }

    async fn estimate_gas_limit(
        &self,
        tx: &TypedTransaction,
        function: &Function,
    ) -> Result<U256, ChainCommunicationError> {
        let contract_call = self.build_contract_call::<()>(tx.clone(), function.clone());
        let gas_limit = contract_call.estimate_gas().await?.into();
        Ok(gas_limit)
    }

    async fn send(&self, tx: &TypedTransaction, function: &Function) -> ChainResult<H256> {
        let contract_call = self.build_contract_call::<()>(tx.clone(), function.clone());
        let pending = contract_call
            .send()
            .await
            .map_err(|e| ChainCommunicationError::CustomError(e.to_string()))?;

        Ok(pending.tx_hash().into())
    }

    async fn check(&self, tx: &TypedTransaction, function: &Function) -> ChainResult<bool> {
        let contract_call = self.build_contract_call::<bool>(tx.clone(), function.clone());
        let success = contract_call
            .call()
            .await
            .map_err(|e| ChainCommunicationError::CustomError(e.to_string()))?;

        Ok(success)
    }

    async fn get_next_nonce_on_finalized_block(&self, address: &Address) -> ChainResult<U256> {
        self.provider
            .get_transaction_count(*address, Some(BlockId::Number(BlockNumber::Finalized)))
            .await
            .map_err(ChainCommunicationError::from_other)
            .map(Into::into)
    }
}

#[async_trait]
impl<M> HyperlaneProvider for EthereumProvider<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let block = get_with_retry_on_none(
            &height,
            |h| self.provider.get_block(*h),
            |h| HyperlaneProviderError::CouldNotFindBlockByHeight(*h),
        )
        .await?;

        let block_height = block
            .number
            .ok_or(HyperlaneProviderError::CouldNotFindBlockByHeight(height))?
            .as_u64();

        if block_height != height {
            Err(HyperlaneProviderError::IncorrectBlockByHeight(
                height,
                block_height,
            ))?;
        }

        let block_hash = block
            .hash
            .ok_or(HyperlaneProviderError::BlockWithoutHash(height))?;

        let block_info = BlockInfo {
            hash: block_hash.into(),
            timestamp: block.timestamp.as_u64(),
            number: block_height,
        };

        Ok(block_info)
    }

    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let txn = get_with_retry_on_none(
            hash,
            |h| self.provider.get_transaction(*h),
            |h| HyperlaneProviderError::CouldNotFindTransactionByHash(*h),
        )
        .await?;

        let receipt = self
            .provider
            .get_transaction_receipt(*hash)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .map(|r| -> Result<_, HyperlaneProviderError> {
                Ok(TxnReceiptInfo {
                    gas_used: r.gas_used.ok_or(HyperlaneProviderError::NoGasUsed)?.into(),
                    cumulative_gas_used: r.cumulative_gas_used.into(),
                    effective_gas_price: r.effective_gas_price.map(Into::into),
                })
            })
            .transpose()?;

        let txn_info = TxnInfo {
            hash: *hash,
            max_fee_per_gas: txn.max_fee_per_gas.map(Into::into),
            max_priority_fee_per_gas: txn.max_priority_fee_per_gas.map(Into::into),
            gas_price: txn.gas_price.map(Into::into),
            gas_limit: txn.gas.into(),
            nonce: txn.nonce.as_u64(),
            sender: txn.from.into(),
            recipient: txn.to.map(Into::into),
            receipt,
            raw_input_data: Some(txn.input.to_vec()),
        };

        Ok(txn_info)
    }

    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        let code = self
            .provider
            .get_code(ethers_core_types::H160::from(*address), None)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        Ok(!code.is_empty())
    }

    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        // Can't use the address directly as a string, because ethers interprets it
        // as an ENS name rather than an address.
        let addr: Address = address.parse()?;
        let balance = self
            .provider
            .get_balance(addr, None)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        Ok(balance.into())
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        let Some(block) = self
            .provider
            .get_block(BlockNumber::Latest)
            .await
            .map_err(|e| {
                ChainCommunicationError::Other(HyperlaneCustomErrorWrapper::new(Box::new(e)))
            })?
        else {
            tracing::trace!(domain=?self.domain, "Latest block not found");
            return Ok(None);
        };

        // Given the block is queried with `BlockNumber::Latest` rather than `BlockNumber::Pending`,
        // if `block` is Some at this point, we're guaranteed to have its `hash` and `number` defined,
        // so it's safe to unwrap below
        // more info at <https://docs.rs/ethers/latest/ethers/core/types/struct.Block.html#structfield.number>
        let chain_metrics = ChainInfo::new(
            BlockInfo {
                hash: block.hash.unwrap().into(),
                timestamp: block.timestamp.as_u64(),
                number: block.number.unwrap().as_u64(),
            },
            block.base_fee_per_gas.map(Into::into),
        );
        Ok(Some(chain_metrics))
    }
}

impl<M> EthereumProvider<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn get_storage_at(&self, address: H256, location: H256) -> ChainResult<H256> {
        let storage = self
            .provider
            .get_storage_at(
                ethers_core_types::H160::from(address),
                location.into(),
                None,
            )
            .await
            .map_err(ChainCommunicationError::from_other)?;
        Ok(storage.into())
    }
}

/// Builder for hyperlane providers.
pub struct SubmitterProviderBuilder {}

#[async_trait]
impl BuildableWithProvider for SubmitterProviderBuilder {
    type Output = Box<dyn EvmProviderForSubmitter>;
    const NEEDS_SIGNER: bool = true;

    // the submitter does not use the ethers submission middleware.
    // it uses its own logic for setting transaction parameters
    // and landing them onchain
    fn uses_ethers_submission_middleware(&self) -> bool {
        false
    }

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumProvider::new(
            Arc::new(provider),
            locator.domain.clone(),
        ))
    }
}

/// Builder for hyperlane providers.
pub struct HyperlaneProviderBuilder {}

#[async_trait]
impl BuildableWithProvider for HyperlaneProviderBuilder {
    type Output = Box<dyn HyperlaneProvider>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumProvider::new(
            Arc::new(provider),
            locator.domain.clone(),
        ))
    }
}

/// Call a get function that returns a Result<Option<T>> and retry if the inner
/// option is None. This can happen because the provider has not discovered the
/// object we are looking for yet.
async fn get_with_retry_on_none<T, F, O, E, I, N>(
    id: &I,
    get: F,
    not_found_error: N,
) -> ChainResult<T>
where
    F: Fn(&I) -> O,
    O: Future<Output = Result<Option<T>, E>>,
    E: std::error::Error + Send + Sync + 'static,
    N: Fn(&I) -> HyperlaneProviderError,
{
    for _ in 0..3 {
        if let Some(t) = get(id).await.map_err(ChainCommunicationError::from_other)? {
            return Ok(t);
        } else {
            sleep(Duration::from_secs(5)).await;
            continue;
        };
    }
    Err(not_found_error(id).into())
}
