use async_trait::async_trait;
use std::fmt::Debug;
use std::sync::Arc;

use ethers::prelude::{Middleware, H256, U256};
use eyre::eyre;

use crate::MakeableWithProvider;
use abacus_core::{AbacusChain, AbacusProvider, BlockInfo, ContractLocator, TxnInfo};

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

    fn local_domain(&self) -> u32 {
        self.domain
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
            .get_block(*hash)
            .await?
            .ok_or_else(|| eyre!("Could not find block with hash {}", hash))?;
        assert_eq!(block.hash.as_ref().unwrap(), hash);
        debug_assert_eq!(U256::from(block.timestamp.as_u64()), block.timestamp);
        Ok(BlockInfo {
            hash: *hash,
            timestamp: block.timestamp.as_u64(),
            number: block
                .number
                .ok_or_else(|| eyre!("Block is not part of the chain yet {}", hash))?
                .as_u64(),
            gas_used: block.gas_used,
            gas_limit: block.gas_limit,
        })
    }

    async fn get_txn_by_hash(&self, hash: &H256) -> eyre::Result<TxnInfo> {
        let txn = self
            .provider
            .get_transaction_receipt(*hash)
            .await?
            .ok_or_else(|| eyre!("Could not find txn with hash {}", hash))?;

        assert_eq!(&txn.hash, hash);
        debug_assert_eq!(U256::from(txn.nonce.as_u64()), txn.nonce);

        Ok(TxnInfo {
            hash: *hash,
            gas_used: txn.gas_used.unwrap_or_else(U256::default),
            gas_price: txn.gas_price.unwrap_or_else(U256::default),
            nonce: txn.nonce.as_u64(),
            sender: txn.from.into(),
            recipient: txn
                .to
                .ok_or_else(|| eyre!("No txn recipient {}", hash))?
                .into(),
        })
    }
}

/// Builder for abacus providers.
pub struct AbacusProviderBuilder {}

#[async_trait]
impl MakeableWithProvider for AbacusProviderBuilder {
    type Output = Box<dyn AbacusProvider>;

    async fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumProvider {
            provider: Arc::new(provider),
            chain_name: locator.chain_name.clone(),
            domain: locator.domain,
        })
    }
}
