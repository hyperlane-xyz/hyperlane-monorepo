use std::ops::RangeInclusive;

use hyperlane_core::{
    ChainCommunicationError, ChainCommunicationError, ChainResult, ChainResult, CheckpointAtBlock,
    HyperlaneChain, HyperlaneChain, HyperlaneContract, HyperlaneContract, HyperlaneDomain,
    HyperlaneDomain, HyperlaneProvider, HyperlaneProvider, IncrementalMerkleAtBlock, Indexed,
    Indexed, Indexer, Indexer, LogMeta, LogMeta, MerkleTreeHook, MerkleTreeHook,
    MerkleTreeInsertion, MerkleTreeInsertion, ReorgPeriod, SequenceAwareIndexer,
    SequenceAwareIndexer, H256, H256, H512, H512,
};
use tonic::async_trait;
use tracing::instrument;

use crate::{KaspaProvider, RpcProvider};

use super::KaspaEventIndexer;

/// delivery indexer to check if a message was delivered
#[derive(Debug, Clone)]
pub struct KaspaMerkle {
    provider: KaspaProvider,
    address: H256,
}

impl HyperlaneChain for KaspaMerkle {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    ///  A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.provider()
    }
}

impl HyperlaneContract for KaspaMerkle {
    /// Return the address of this contract."]
    fn address(&self) -> H256 {
        self.address
    }
}

#[async_trait]
impl MerkleTreeHook for KaspaMerkle {
    /// Return the incremental merkle tree in storage
    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    /// Gets the current leaf count of the merkle tree
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}

impl KaspaEventIndexer<MerkleTreeInsertion> for KaspaMerkle {
    fn provider(&self) -> &RpcProvider {
        self.provider.rpc()
    }

    fn address(&self) -> &H256 {
        &self.address
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for KaspaMerkle {
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for KaspaMerkle {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        Err(ChainCommunicationError::from_other_str("not implemented"))
    }
}
