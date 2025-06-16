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
    CheckpointAtBlock, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, IncrementalMerkleAtBlock, Indexed, Indexer, LogMeta, MerkleTreeHook,
    MerkleTreeInsertion, ReorgPeriod, SequenceAwareIndexer, H256, H512,
};

use crate::{KaspaError, KaspaProvider, RpcProvider};

use super::{KaspaEventIndexer, ParsedEvent};

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
impl MerkleTreeHook for KaspaMerkle {}

impl KaspaEventIndexer<MerkleTreeInsertion> for KaspaMerkle {
    fn target_type() -> String {
        EventInsertedIntoTree::full_name()
    }

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
