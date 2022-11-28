use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::{Middleware, H256};
use eyre::eyre;
use tracing::instrument;

use abacus_core::{
    AbacusChain, AbacusProvider, BlockInfo, TxnInfo, TxnReceiptInfo,
};

/// Connection to an ethereum provider. Useful for querying information about
/// the blockchain.
#[derive(Debug, Clone)]
pub struct EthereumProvider<M>
where
    M: Middleware,
{
    provider: Arc<M>,
    chain_name: String,
    domain: u32,
}

impl<M> AbacusChain for EthereumProvider<M>
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

#[async_trait]
impl<M> AbacusProvider for EthereumProvider<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn get_block_by_hash(&self, hash: &H256) -> eyre::Result<BlockInfo> {
        let block = self
            .provider
            .get_block(*hash)
            .await?
            .ok_or_else(|| eyre!("Could not find block with hash {}", hash))?;
        Ok(BlockInfo {
            hash: *hash,
            timestamp: block.timestamp.as_u64(),
            number: block
                .number
                .ok_or_else(|| eyre!("Block is not part of the chain yet {}", hash))?
                .as_u64(),
        })
    }

    #[instrument(err, skip(self))]
    async fn get_txn_by_hash(&self, hash: &H256) -> eyre::Result<TxnInfo> {
        let txn = self
            .provider
            .get_transaction(*hash)
            .await?
            .ok_or_else(|| eyre!("Could not find txn with hash {}", hash))?;
        let receipt = self
            .provider
            .get_transaction_receipt(*hash)
            .await?
            .map(|r| -> eyre::Result<_> {
                Ok(TxnReceiptInfo {
                    gas_used: r
                        .gas_used
                        .ok_or_else(|| eyre!("Provider did not return gas used"))?,
                    cumulative_gas_used: r.cumulative_gas_used,
                    effective_gas_price: r.effective_gas_price,
                })
            })
            .transpose()?;

        Ok(TxnInfo {
            hash: *hash,
            max_fee_per_gas: txn.max_fee_per_gas,
            max_priority_fee_per_gas: txn.max_priority_fee_per_gas,
            gas_price: txn.gas_price,
            gas_limit: txn.gas,
            nonce: txn.nonce.as_u64(),
            sender: txn.from.into(),
            recipient: txn.to.map(Into::into),
            receipt,
        })
    }
}
