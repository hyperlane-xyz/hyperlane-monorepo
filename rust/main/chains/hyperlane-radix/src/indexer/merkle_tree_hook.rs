use std::ops::RangeInclusive;

use async_trait::async_trait;

use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainResult, Checkpoint, CheckpointAtBlock,
    ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider,
    IncrementalMerkleAtBlock, Indexed, Indexer, LogMeta, MerkleTreeHook, MerkleTreeInsertion,
    ReorgPeriod, SequenceAwareIndexer, H256, H512,
};

use crate::{
    encode_component_address, parse_inserted_into_tree_event, ConnectionConf, MerkleTree,
    RadixProvider,
};

/// Radix Merkle Tree Indexer
#[derive(Debug)]
pub struct RadixMerkleTreeIndexer {
    provider: RadixProvider,
    encoded_address: String,
    address: H256,
    domain: HyperlaneDomain,
}

impl RadixMerkleTreeIndexer {
    /// New MerkleTree indexer instance
    pub fn new(
        provider: RadixProvider,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> ChainResult<Self> {
        let address = encode_component_address(&conf.network, locator.address)?;
        Ok(Self {
            address: locator.address,
            encoded_address: address,
            domain: locator.domain.clone(),
            provider,
        })
    }
}

impl HyperlaneChain for RadixMerkleTreeIndexer {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for RadixMerkleTreeIndexer {
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl MerkleTreeHook for RadixMerkleTreeIndexer {
    /// Return the incremental merkle tree in storage
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        let (tree, state_version) = self
            .provider
            .call_method::<MerkleTree>(
                &self.encoded_address,
                "tree",
                Some(reorg_period),
                Vec::new(),
            )
            .await?;

        let branch = tree.branch.map(|x| H256::from_slice(&x.0));

        let tree: IncrementalMerkle = IncrementalMerkle {
            branch,
            count: tree.count,
        };

        Ok(IncrementalMerkleAtBlock {
            tree,
            block_height: Some(state_version),
        })
    }

    /// Gets the current leaf count of the merkle tree
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let (count, _) = self
            .provider
            .call_method::<u32>(
                &self.encoded_address,
                "count",
                Some(reorg_period),
                Vec::new(),
            )
            .await?;
        Ok(count)
    }

    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        let state_version = self.provider.get_state_version(Some(reorg_period)).await?;
        self.latest_checkpoint_at_block(state_version).await
    }

    async fn latest_checkpoint_at_block(
        &self,
        state_version: u64,
    ) -> ChainResult<CheckpointAtBlock> {
        let ((root, index), _) = self
            .provider
            .call_method_at_state::<(crate::Hash, u32)>(
                &self.encoded_address,
                "latest_checkpoint",
                Some(state_version),
                Vec::new(),
            )
            .await?;

        let (domain, _): (u32, u64) = self
            .provider
            .call_method_at_state(
                &self.encoded_address,
                "local_domain",
                Some(state_version),
                Vec::new(),
            )
            .await?;

        Ok(CheckpointAtBlock {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: self.address,
                mailbox_domain: domain,
                root: H256::from_slice(&root.0),
                index,
            },
            block_height: Some(state_version),
        })
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for RadixMerkleTreeIndexer {
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let events = self
            .provider
            .fetch_logs_in_range(&self.encoded_address, range, parse_inserted_into_tree_event)
            .await?;
        let result = events
            .into_iter()
            .map(|(event, meta)| {
                let message: MerkleTreeInsertion =
                    MerkleTreeInsertion::new(event.index, event.id.into());
                let sequence = event.index;
                (Indexed::new(message).with_sequence(sequence), meta)
            })
            .collect();
        Ok(result)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Ok(self.provider.get_state_version(None).await?.try_into()?)
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let events = self
            .provider
            .fetch_logs_by_hash(
                &self.encoded_address,
                &tx_hash,
                parse_inserted_into_tree_event,
            )
            .await?;
        let result = events
            .into_iter()
            .map(|(event, meta)| {
                let message: MerkleTreeInsertion =
                    MerkleTreeInsertion::new(event.index, event.id.into());
                let sequence = event.index;
                (Indexed::new(message).with_sequence(sequence), meta)
            })
            .collect();
        Ok(result)
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for RadixMerkleTreeIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let (sequence, state_version): (u32, u64) = self
            .provider
            .call_method(&self.encoded_address, "count", None, Vec::new())
            .await?;
        Ok((Some(sequence), state_version.try_into()?))
    }
}
