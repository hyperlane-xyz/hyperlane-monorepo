use std::{fmt, sync::Arc};

use async_trait::async_trait;

use cosmrs::tendermint::{hash::Algorithm, Hash};
use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainResult, HyperlaneChain, HyperlaneDomain,
    HyperlaneProvider, TxnInfo, H256,
};
use tendermint_rpc::{client::CompatMode, Client as CosmosClient};

/// A wrapper around a cosmos provider to get generic blockchain information.
#[derive(Debug, Clone)]
pub struct CosmosProvider<C>
where
    C: CosmosClient + Send + Sync + fmt::Debug + 'static,
{
    compat_mode: CompatMode,
    domain: HyperlaneDomain,
    provider: Arc<C>,
}

impl<C> HyperlaneChain for CosmosProvider<C>
where
    C: CosmosClient + Send + Sync + fmt::Debug + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(CosmosProvider {
            compat_mode: self.compat_mode,
            domain: self.domain.clone(),
            provider: self.provider.clone(),
        })
    }
}

#[async_trait]
impl<C> HyperlaneProvider for CosmosProvider<C>
where
    C: CosmosClient + Send + fmt::Debug + Sync + 'static,
{
    async fn get_block_by_hash(&self, hash: &H256) -> ChainResult<BlockInfo> {
        // hash formats sha256 digest in bytes format (32bytes)

        // get block info from cosmos chain
        let tm_hash: Hash = Hash::from_bytes(Algorithm::Sha256, hash.as_bytes()).unwrap();
        let block_info = self.provider.block_by_hash(tm_hash).await?;

        match block_info.block {
            Some(block) => {
                let block_hash = block.header.hash();
                let block_number = block.header.height.value();
                let block_timestamp = block.header.time;

                Ok(BlockInfo {
                    hash: *hash,
                    timestamp: block_timestamp.unix_timestamp().try_into().unwrap(),
                    number: block_number,
                })
            }
            None => Err(ChainCommunicationError::BlockNotFound(*hash)),
        }
    }

    async fn get_txn_by_hash(&self, hash: &H256) -> ChainResult<TxnInfo> {
        // hash formats sha256 digest in bytes format (32bytes)

        let tm_hash: Hash = Hash::from_bytes(Algorithm::Sha256, hash.as_bytes()).unwrap();
        let txn_info = self.provider.tx(tm_hash, true).await?;

        todo!()
    }
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        todo!()
    }
}
