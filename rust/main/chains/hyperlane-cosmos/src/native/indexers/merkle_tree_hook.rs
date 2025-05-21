use std::ops::RangeInclusive;

use hex::ToHex;
use hyperlane_cosmos_rs::{
    hyperlane::core::post_dispatch::v1::{
        EventInsertedIntoTree, TreeResponse, WrappedMerkleTreeHookResponse,
    },
    prost::Name,
};
use itertools::Itertools;
use tendermint::abci::EventAttribute;
use tonic::async_trait;
use tracing::instrument;

use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult, Checkpoint,
    ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider,
    Indexed, Indexer, LogMeta, MerkleTreeHook, MerkleTreeInsertion, ReorgPeriod,
    SequenceAwareIndexer, H256, H512,
};

use crate::{
    native::module_query_client::ModuleQueryClient, CosmosProvider, HyperlaneCosmosError,
    RpcProvider,
};

use crate::indexer::{CosmosEventIndexer, ParsedEvent};

/// Merkle Tree Hook Indexer
#[derive(Debug, Clone)]
pub struct CosmosNativeMerkleTreeHook {
    provider: CosmosProvider<ModuleQueryClient>,
    address: H256,
}

impl CosmosNativeMerkleTreeHook {
    ///  New Tree Insertion Indexer
    pub fn new(
        provider: CosmosProvider<ModuleQueryClient>,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(CosmosNativeMerkleTreeHook {
            provider,
            address: locator.address,
        })
    }

    async fn get_merkle_tree(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<(WrappedMerkleTreeHookResponse, TreeResponse)> {
        let height = self.provider.reorg_to_height(reorg_period).await?;
        let hook = self
            .provider
            .query()
            .merkle_tree_hook(self.address.encode_hex(), height)
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

impl HyperlaneChain for CosmosNativeMerkleTreeHook {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    ///  A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.provider()
    }
}

impl HyperlaneContract for CosmosNativeMerkleTreeHook {
    /// Return the address of this contract."]
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl MerkleTreeHook for CosmosNativeMerkleTreeHook {
    /// Return the incremental merkle tree in storage
    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkle> {
        let (_, tree) = self.get_merkle_tree(reorg_period).await?;
        let branch = tree
            .leafs
            .iter()
            .map(|hash| H256::from_slice(hash))
            .collect_vec();

        let branch = branch.as_slice();
        let branch: [H256; 32] = match branch.try_into() {
            Ok(ba) => ba,
            Err(_) => {
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
        Ok(tree.count)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn latest_checkpoint(&self, reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint> {
        let (_, tree) = self.get_merkle_tree(reorg_period).await?;
        let root = H256::from_slice(&tree.root);
        let index = if tree.count == 0 { 0 } else { tree.count - 1 };

        Ok(Checkpoint {
            merkle_tree_hook_address: self.address,
            mailbox_domain: self.domain().id(),
            root,
            index,
        })
    }
}

impl CosmosEventIndexer<MerkleTreeInsertion> for CosmosNativeMerkleTreeHook {
    fn target_type() -> String {
        EventInsertedIntoTree::full_name()
    }

    fn provider(&self) -> &RpcProvider {
        self.provider.rpc()
    }

    #[instrument(err)]
    fn parse(&self, attrs: &[EventAttribute]) -> ChainResult<ParsedEvent<MerkleTreeInsertion>> {
        let mut message_id: Option<H256> = None;
        let mut leaf_index: Option<u32> = None;
        let mut contract_address: Option<H256> = None;

        for attribute in attrs {
            let key = attribute.key_str().map_err(HyperlaneCosmosError::from)?;
            let value = attribute
                .value_str()
                .map_err(HyperlaneCosmosError::from)?
                .replace("\"", "");
            match key {
                "message_id" => {
                    message_id = Some(value.parse()?);
                }
                "merkle_tree_hook_id" => {
                    contract_address = Some(value.parse()?);
                }
                "index" => leaf_index = Some(value.parse()?),
                _ => continue,
            }
        }

        let contract_address = contract_address
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing contract_address"))?;
        let message_id = message_id
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing message_id"))?;
        let leaf_index = leaf_index
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing leafindex"))?;
        let insertion = MerkleTreeInsertion::new(leaf_index, message_id);

        Ok(ParsedEvent::new(contract_address, insertion))
    }

    fn address(&self) -> &H256 {
        &self.address
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for CosmosNativeMerkleTreeHook {
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        CosmosEventIndexer::fetch_logs_in_range(self, range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        CosmosEventIndexer::get_finalized_block_number(self).await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        CosmosEventIndexer::fetch_logs_by_tx_hash(self, tx_hash).await
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for CosmosNativeMerkleTreeHook {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = CosmosEventIndexer::get_finalized_block_number(self).await?;
        let merkle_tree = self
            .provider
            .query()
            .merkle_tree_hook(self.address.encode_hex(), Some(tip as u64))
            .await?;
        match merkle_tree.merkle_tree_hook {
            Some(merkle_tree) if merkle_tree.merkle_tree.is_some() => {
                let count = merkle_tree.merkle_tree.unwrap().count;
                Ok((Some(count), tip))
            }
            _ => Ok((None, tip)),
        }
    }
}
