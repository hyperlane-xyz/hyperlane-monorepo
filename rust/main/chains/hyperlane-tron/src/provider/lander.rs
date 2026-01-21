use ethers::{
    abi::{Detokenize, Function},
    providers::Middleware,
    types::{transaction::eip2718::TypedTransaction, TransactionReceipt},
};
use ethers_contract::decode_function_data;
use tonic::async_trait;

use hyperlane_core::{ChainCommunicationError, ChainResult, H256, H512};

use crate::TronProvider;

/// Trait defining the necessary methods for a Tron provider to be used by the lander.
#[async_trait]
pub trait TronProviderForLander: Send + Sync {
    /// Gets the transaction receipt for a given transaction hash.
    async fn get_transaction_receipt(
        &self,
        transaction_hash: H512,
    ) -> ChainResult<Option<TransactionReceipt>>;

    /// Gets the latest finalized block number.
    async fn get_finalized_block_number(&self) -> ChainResult<u32>;

    /// Submits a transaction to the Tron network.
    async fn submit_tx(&self, tx: &TypedTransaction) -> ChainResult<H256>;

    /// Estimates the gas required for a transaction.
    async fn estimate_gas(&self, tx: &TypedTransaction) -> ChainResult<ethers::types::U256>;

    /// Calls a read-only function on the Tron network.
    async fn call<T: Detokenize>(
        &self,
        tx: &TypedTransaction,
        function: &Function,
    ) -> ChainResult<T>;
}

#[async_trait]
impl TronProviderForLander for TronProvider {
    async fn get_transaction_receipt(
        &self,
        transaction_hash: H512,
    ) -> ChainResult<Option<TransactionReceipt>> {
        Ok(Middleware::get_transaction_receipt(self, transaction_hash).await?)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        TronProvider::get_finalized_block_number(self).await
    }

    async fn submit_tx(&self, tx: &TypedTransaction) -> ChainResult<H256> {
        TronProvider::submit_tx(self, tx).await
    }

    async fn estimate_gas(&self, tx: &TypedTransaction) -> ChainResult<ethers::types::U256> {
        Ok(Middleware::estimate_gas(self, tx, None).await?)
    }

    async fn call<T: Detokenize>(
        &self,
        tx: &TypedTransaction,
        function: &Function,
    ) -> ChainResult<T> {
        let bytes = Middleware::call(self, tx, None).await?;
        let success = decode_function_data::<T, _>(function, &bytes, false)
            .map_err(ChainCommunicationError::from_other)?;
        Ok(success)
    }
}
