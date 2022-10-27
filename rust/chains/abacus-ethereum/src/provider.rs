use async_trait::async_trait;
use std::fmt::Debug;
use std::sync::Arc;

use ethers::prelude::{Middleware, H256};
use eyre::eyre;

use abacus_core::{AbacusChain, AbacusProvider, BlockInfo, TxnInfo};

#[derive(Debug, Clone)]
pub struct EthereumProvider<M>
where
    M: Middleware,
{
    provider: Arc<M>,
}

impl<M> AbacusChain for EthereumProvider<M>
where
    M: Middleware + 'static,
{
    fn chain_name(&self) -> &str {
        todo!()
    }

    fn local_domain(&self) -> u32 {
        todo!()
    }
}

impl<M> From<M> for EthereumProvider<M>
where
    M: Middleware,
{
    fn from(provider: M) -> Self {
        Self { provider }
    }
}

#[async_trait]
impl<M> AbacusProvider for EthereumProvider<M>
where
    M: Middleware + 'static,
{
    async fn get_block_by_hash(&self, hash: &H256) -> eyre::Result<BlockInfo> {
        let block = self
            .provider
            .get_block(hash)
            .await?
            .ok_or_else(|| eyre!("Could not find block with hash {}", hash.encode_hex()))?;
        assert_eq!(block.hash.as_ref().unwrap(), block);
        debug_assert_eq!(block.timestamp.as_u64(), block.timestamp);
        Ok(BlockInfo {
            hash: *hash,
            timestamp: block.timestamp.as_u64(),
            number: block
                .number
                .ok_or_else(|| eyre!("Block is not part of the chain yet {}", hash.encode_hex()))?
                .as_u64(),
            gas_used: block.gas_used,
            gas_limit: block.gas_limit,
        })
    }

    async fn get_txn_by_hash(&self, hash: &H256) -> eyre::Result<TxnInfo> {
        let txn = self
            .provider
            .get_transaction(hash)
            .await?
            .ok_or_else(|| eyre!("Could not find txn with hash {}", hash.encode_hex()))?;

        assert_eq!(txn.hash.as_ref(), hash);
        debug_assert_eq!(txn.nonce.as_u64(), txn.nonce);

        Ok(TxnInfo {
            hash: *hash,
            gas_used: txn.gas,
            gas_price: txn
                .gas_price
                .ok_or_else(|| eyre!("Txn is not part of the chain yet {}", hash.encode_hex()))?,
            nonce: txn.nonce.as_u64(),
            sender: txn.from.into(),
            recipient: txn
                .to
                .ok_or_else(|| eyre!("No txn recipient {}", hash.encode_hex()))?
                .into(),
        })
    }
}
