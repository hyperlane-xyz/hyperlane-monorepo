use std::fmt::Debug;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use derive_new::new;
use ethers::prelude::Middleware;
use ethers_core::{abi::Address, types::BlockNumber};
use hyperlane_core::{ethers_core_types, ChainInfo, HyperlaneCustomErrorWrapper, U256};
use tokio::time::sleep;
use tracing::instrument;

use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, TxnInfo, TxnReceiptInfo, H256,
};

use crate::{BuildableWithProvider, ConnectionConf};

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

#[async_trait]
impl<M> HyperlaneProvider for EthereumProvider<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn get_block_by_hash(&self, hash: &H256) -> ChainResult<BlockInfo> {
        let block = get_with_retry_on_none(hash, |h| {
            let eth_h256: ethers_core_types::H256 = h.into();
            self.provider.get_block(eth_h256)
        })
        .await?;
        Ok(BlockInfo {
            hash: *hash,
            timestamp: block.timestamp.as_u64(),
            number: block
                .number
                .ok_or(HyperlaneProviderError::BlockIsNotPartOfChainYet(*hash))?
                .as_u64(),
        })
    }

    #[instrument(err, skip(self))]
    async fn get_txn_by_hash(&self, hash: &H256) -> ChainResult<TxnInfo> {
        let txn = get_with_retry_on_none(hash, |h| self.provider.get_transaction(*h)).await?;
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

        Ok(TxnInfo {
            hash: *hash,
            max_fee_per_gas: txn.max_fee_per_gas.map(Into::into),
            max_priority_fee_per_gas: txn.max_priority_fee_per_gas.map(Into::into),
            gas_price: txn.gas_price.map(Into::into),
            gas_limit: txn.gas.into(),
            nonce: txn.nonce.as_u64(),
            sender: txn.from.into(),
            recipient: txn.to.map(Into::into),
            receipt,
        })
    }

    #[instrument(err, skip(self))]
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        let code = self
            .provider
            .get_code(ethers_core_types::H160::from(*address), None)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        Ok(!code.is_empty())
    }

    #[instrument(err, skip(self))]
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
pub struct HyperlaneProviderBuilder {}

#[async_trait]
impl BuildableWithProvider for HyperlaneProviderBuilder {
    type Output = Box<dyn HyperlaneProvider>;

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
async fn get_with_retry_on_none<T, F, O, E>(hash: &H256, get: F) -> ChainResult<T>
where
    F: Fn(&H256) -> O,
    O: Future<Output = Result<Option<T>, E>>,
    E: std::error::Error + Send + Sync + 'static,
{
    for _ in 0..3 {
        if let Some(t) = get(hash)
            .await
            .map_err(ChainCommunicationError::from_other)?
        {
            return Ok(t);
        } else {
            sleep(Duration::from_secs(5)).await;
            continue;
        };
    }
    Err(HyperlaneProviderError::CouldNotFindObjectByHash(*hash).into())
}
