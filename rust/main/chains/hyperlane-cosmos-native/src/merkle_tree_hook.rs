use std::fmt::Debug;

use async_trait::async_trait;
use base64::Engine;
use itertools::Itertools;
use tracing::instrument;

use hyperlane_core::accumulator::incremental::IncrementalMerkle;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, ContractLocator, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneProvider, MerkleTreeHook, ReorgPeriod, H256,
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
        let hook = self
            .provider
            .rest()
            .merkle_tree_hook(self.address, reorg_period.clone())
            .await?;

        let branch = hook
            .merkle_tree
            .leafs
            .iter()
            .map(|hash| {
                let result = base64::prelude::BASE64_STANDARD.decode(hash);
                match result {
                    Ok(vec) => Ok(H256::from_slice(&vec)),
                    Err(e) => Err(e),
                }
            })
            .filter_map(|hash| hash.ok())
            .collect_vec();

        if branch.len() < hook.merkle_tree.leafs.len() {
            return Err(ChainCommunicationError::CustomError(
                "Failed to parse incremental merkle tree".to_string(),
            ));
        }
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
            count: hook.merkle_tree.count,
        })
    }

    /// Gets the current leaf count of the merkle tree
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let result = self
            .provider
            .rest()
            .merkle_tree_hook(self.address, reorg_period.clone())
            .await?;

        Ok(result.merkle_tree.count as u32)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint> {
        let response = self
            .provider
            .rest()
            .merkle_tree_hook(self.address, reorg_period.clone())
            .await?;
        let root = base64::prelude::BASE64_STANDARD
            .decode(response.merkle_tree.root)
            .map_err(Into::<HyperlaneCosmosError>::into)?;
        let root = H256::from_slice(&root);

        let index = if response.merkle_tree.count == 0 {
            0
        } else {
            response.merkle_tree.count as u32 - 1
        };

        Ok(Checkpoint {
            merkle_tree_hook_address: self.address,
            mailbox_domain: self.domain.id(),
            root,
            index,
        })
    }
}
