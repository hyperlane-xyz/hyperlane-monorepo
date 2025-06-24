use std::fmt::Debug;
use std::future::Future;
use std::marker::PhantomData;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use derive_new::new;
use ethers::prelude::Middleware;
use ethers::types::{Block, TransactionReceipt, H160, H256 as EthersH256};
use ethers_contract::{builders::ContractCall, Multicall, MulticallResult};
use ethers_core::abi::{Address, Function};
use ethers_core::types::transaction::eip2718::TypedTransaction;
use ethers_core::types::{BlockId, BlockNumber, FeeHistory, U256 as EthersU256};
use tokio::sync::Mutex;
use tokio::time::sleep;
use tracing::instrument;

use hyperlane_core::{
    ethers_core_types, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, ContractLocator,
    HyperlaneChain, HyperlaneCustomErrorWrapper, HyperlaneDomain, HyperlaneProvider,
    HyperlaneProviderError, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};

use crate::{
    get_finalized_block_number, multicall, BatchCache, BuildableWithProvider, ConnectionConf,
    EthereumReorgPeriod,
};

// From
// gas_limit: QUANTITY, 32 bytes - The maximum amount of gas that can be used.
// max_fee_per_gas: QUANTITY, 32 bytes - The maximum fee per unit of gas that the sender is willing to pay.
// max_priority_fee_per_gas: QUANTITY, 32 bytes - The maximum priority fee per unit of gas to incentivize miners.
// gas_per_pubdata_limit: QUANTITY, 32 bytes - The gas limit per unit of public data.
/// Response from the zkSync estimate fee endpoint.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct ZksyncEstimateFeeResponse {
    /// Gas limit
    pub gas_limit: EthersU256,
    /// Max fee
    pub max_fee_per_gas: EthersU256,
    /// Max priority fee
    pub max_priority_fee_per_gas: EthersU256,
    /// Gas per pubdata limit
    pub gas_per_pubdata_limit: EthersU256,
}

/// Connection to an ethereum provider. Useful for querying information about
/// the blockchain.
#[derive(Debug, Clone, new)]
pub struct EthereumProvider<M> {
    provider: Arc<M>,
    domain: HyperlaneDomain,
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
pub trait EvmProviderForLander: Send + Sync {
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
    ) -> ChainResult<U256>;

    /// Batches precursors into a single transaction
    async fn batch(
        &self,
        cache: Arc<Mutex<BatchCache>>,
        batch_contract_address: H256,
        precursors: Vec<(TypedTransaction, Function)>,
        signer: H160,
    ) -> ChainResult<(TypedTransaction, Function)>;

    /// Simulate the batch transaction without sending it to the blockchain
    async fn simulate(
        &self,
        multi_precursor: (TypedTransaction, Function),
    ) -> ChainResult<(Vec<usize>, Vec<(usize, String)>)>;

    /// Estimate the batch transaction, which includes a multi-precursor transaction
    async fn estimate_batch(
        &self,
        multi_precursor: (TypedTransaction, Function),
        precursors: Vec<(TypedTransaction, Function)>,
    ) -> ChainResult<U256>;

    /// Send transaction into blockchain
    async fn send(&self, tx: &TypedTransaction, function: &Function) -> ChainResult<H256>;

    /// Read-only call into blockchain which returns a boolean
    async fn check(&self, tx: &TypedTransaction, function: &Function) -> ChainResult<bool>;

    /// Get the next nonce to use for a given address (using the finalized block)
    async fn get_next_nonce_on_finalized_block(
        &self,
        address: &Address,
        reorg_period: &EthereumReorgPeriod,
    ) -> ChainResult<U256>;

    /// Get the fee history
    async fn fee_history(
        &self,
        block_count: U256,
        last_block: BlockNumber,
        reward_percentiles: &[f64],
    ) -> ChainResult<FeeHistory>;

    /// Estimate the fee for a zkSync transaction
    async fn zk_estimate_fee(
        &self,
        tx: &TypedTransaction,
    ) -> ChainResult<ZksyncEstimateFeeResponse>;

    /// Get default sender
    fn get_signer(&self) -> Option<H160>;
}

#[async_trait]
impl<M> EvmProviderForLander for EthereumProvider<M>
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
    ) -> ChainResult<U256> {
        let contract_call = self.build_contract_call::<()>(tx.clone(), function.clone());
        let gas_limit = contract_call.estimate_gas().await?.into();
        Ok(gas_limit)
    }

    async fn batch(
        &self,
        cache: Arc<Mutex<BatchCache>>,
        batch_contract_address: H256,
        precursors: Vec<(TypedTransaction, Function)>,
        signer: H160,
    ) -> ChainResult<(TypedTransaction, Function)> {
        let mut multicall = self.create_multicall(cache, batch_contract_address).await?;
        let contract_calls = self.create_contract_calls(precursors);
        let multicall_contract_call = multicall::batch(&mut multicall, contract_calls);

        let mut tx = multicall_contract_call.tx;
        tx.set_from(signer);

        let function = multicall_contract_call.function;

        Ok((tx, function))
    }

    async fn simulate(
        &self,
        multi_precursor: (TypedTransaction, Function),
    ) -> ChainResult<(Vec<usize>, Vec<(usize, String)>)> {
        let (multi_tx, multi_function) = multi_precursor;
        let multicall_contract_call =
            self.build_contract_call::<Vec<MulticallResult>>(multi_tx, multi_function);
        let call_results = multicall_contract_call.call().await?;

        let (successful, failed) = multicall::filter(&call_results);

        Ok((successful, failed))
    }

    async fn estimate_batch(
        &self,
        multi_precursor: (TypedTransaction, Function),
        precursors: Vec<(TypedTransaction, Function)>,
    ) -> ChainResult<U256> {
        let (multi_tx, multi_function) = multi_precursor;
        let multicall_contract_call = self.build_contract_call::<()>(multi_tx, multi_function);
        let contract_calls = self.create_contract_calls(precursors);

        let gas_limit = multicall::estimate(&multicall_contract_call, contract_calls).await?;
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

    async fn get_next_nonce_on_finalized_block(
        &self,
        address: &Address,
        reorg_period: &EthereumReorgPeriod,
    ) -> ChainResult<U256> {
        let finalized_block_number = self.get_finalized_block_number(reorg_period).await?;
        self.provider
            .get_transaction_count(
                *address,
                Some(BlockId::Number(BlockNumber::Number(
                    finalized_block_number.into(),
                ))),
            )
            .await
            .map_err(ChainCommunicationError::from_other)
            .map(Into::into)
    }

    async fn fee_history(
        &self,
        block_count: U256,
        last_block: BlockNumber,
        reward_percentiles: &[f64],
    ) -> ChainResult<FeeHistory> {
        self.provider
            .fee_history(block_count, last_block, reward_percentiles)
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    async fn zk_estimate_fee(
        &self,
        tx: &TypedTransaction,
    ) -> ChainResult<ZksyncEstimateFeeResponse> {
        self.provider
            .provider()
            .request("zks_estimateFee", [tx.clone()])
            .await
            .map_err(ChainCommunicationError::from_other)
    }

    fn get_signer(&self) -> Option<H160> {
        self.provider.default_sender()
    }
}

impl<M> EthereumProvider<M>
where
    M: 'static + Middleware,
{
    /// Create a ContractCall object for a given transaction and function.
    fn build_contract_call<D>(
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

    fn create_contract_calls(
        &self,
        precursors: Vec<(TypedTransaction, Function)>,
    ) -> Vec<ContractCall<M, ()>> {
        precursors
            .into_iter()
            .map(|(tx, f)| self.build_contract_call::<()>(tx, f))
            .collect::<Vec<_>>()
    }

    async fn create_multicall(
        &self,
        cache: Arc<Mutex<BatchCache>>,
        batch_contract_address: H256,
    ) -> eyre::Result<Multicall<M>> {
        multicall::build_multicall(
            self.provider.clone(),
            self.domain.clone(),
            cache,
            batch_contract_address,
        )
        .await
    }

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
            tracing::trace!(domain=?self.domain.name(), "Latest block not found");
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

/// Builder for hyperlane providers.
pub struct LanderProviderBuilder {}

#[async_trait]
impl BuildableWithProvider for LanderProviderBuilder {
    type Output = Arc<dyn EvmProviderForLander>;
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
        Arc::new(EthereumProvider::new(
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
