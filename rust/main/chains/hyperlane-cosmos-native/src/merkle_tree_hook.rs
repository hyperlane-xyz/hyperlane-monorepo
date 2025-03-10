use std::fmt::Debug;

use async_trait::async_trait;
use base64::Engine;
use futures::future::ok;
use hex::ToHex;
use hyperlane_cosmos_rs::hyperlane::core::post_dispatch::v1::{
    TreeResponse, WrappedMerkleTreeHookResponse,
};
use itertools::Itertools;
use tracing::instrument;

use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult, Checkpoint,
    ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider,
    MerkleTreeHook, ReorgPeriod, H256,
};

use crate::{ConnectionConf, CosmosNativeProvider, HyperlaneCosmosError, Signer};

#[derive(Debug, Clone)]
/// A reference to a MerkleTreeHook contract on some Cosmos chain
pub struct CosmosMerkleTreeHook {
    /// Domain
    domain: HyperlaneDomain,
    /// Contract address
    address: H256,
    /// Provider
    provider: CosmosNativeProvider,
}

impl CosmosMerkleTreeHook {
    /// create new Cosmos MerkleTreeHook agent
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider = CosmosNativeProvider::new(
            locator.domain.clone(),
            conf.clone(),
            locator.clone(),
            signer,
        )?;

        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
    }

    async fn get_merkle_tree(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<(WrappedMerkleTreeHookResponse, TreeResponse)> {
        let height = self.provider.reorg_to_height(reorg_period).await?;
        let hook = self
            .provider
            .grpc()
            .merkle_tree_hook(self.address.encode_hex(), Some(height))
            .await?;
        let hook = hook
            .merkle_tree_hook
            .ok_or_else(|| ChainCommunicationError::from_other_str("Missing merkle_tree_hook"))?;
        let tree = hook
            .clone()
            .merkle_tree
            .ok_or_else(|| ChainCommunicationError::from_other_str("Missing merkle_tree"))?;
        Ok((hook, tree))
    }
}

impl HyperlaneContract for CosmosMerkleTreeHook {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CosmosMerkleTreeHook {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl MerkleTreeHook for CosmosMerkleTreeHook {
    /// Return the incremental merkle tree in storage
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkle> {
        let (hook, tree) = self.get_merkle_tree(reorg_period).await?;
        let branch = tree
            .leafs
            .iter()
            .map(|hash| H256::from_slice(&hash))
            .collect_vec();

        let branch = branch.as_slice();
        let branch: [H256; 32] = match branch.try_into() {
            Ok(ba) => ba,
            Err(e) => {
                return Err(ChainCommunicationError::CustomError(
                    "Failed to convert incremental tree. expected branch length of 32".to_string(),
                ))
            }
        };
        Ok(IncrementalMerkle {
            branch,
            count: tree.count as usize,
        })
    }

    /// Gets the current leaf count of the merkle tree
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let (_, tree) = self.get_merkle_tree(reorg_period).await?;
        Ok(tree.count as u32)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint> {
        let (hook, tree) = self.get_merkle_tree(reorg_period).await?;
        let root = H256::from_slice(&tree.root);
        let index = if tree.count == 0 {
            0
        } else {
            tree.count as u32 - 1
        };

        Ok(Checkpoint {
            merkle_tree_hook_address: self.address,
            mailbox_domain: self.domain.id(),
            root,
            index,
        })
    }
}
