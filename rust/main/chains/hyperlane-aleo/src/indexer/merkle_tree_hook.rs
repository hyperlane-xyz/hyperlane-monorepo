use std::{ops::RangeInclusive, str::FromStr};

use async_trait::async_trait;
use snarkvm::prelude::{Address, FromBytes, Network, Plaintext};

use hyperlane_core::{
    ChainResult, Checkpoint, CheckpointAtBlock, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, IncrementalMerkleAtBlock, Indexed, Indexer, LogMeta,
    MerkleTreeHook, MerkleTreeInsertion, ReorgPeriod, SequenceAwareIndexer, H256, H512,
};

use crate::{
    indexer::AleoIndexer,
    provider::{AleoClient, BaseHttpClient},
    utils::aleo_hash_to_h256,
    AleoMerkleTreeHookStruct, AleoProvider, ConnectionConf, CurrentNetwork, HookEventIndex,
    HyperlaneAleoError, InsertIntoTreeEvent,
};

/// Aleo MerkleTreeHook Indexer
#[derive(Debug, Clone)]
pub struct AleoMerkleTreeHook<C: AleoClient = BaseHttpClient> {
    client: AleoProvider<C>,
    address: H256,
    program: String,
    aleo_address: Address<CurrentNetwork>,
    domain: HyperlaneDomain,
}

impl<C: AleoClient> AleoMerkleTreeHook<C> {
    /// Creates a new Merkle Tree Hook
    pub fn new(
        provider: AleoProvider<C>,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> ChainResult<Self> {
        let aleo_address = Address::<CurrentNetwork>::from_bytes_le(locator.address.as_bytes())
            .map_err(HyperlaneAleoError::from)?;
        Ok(Self {
            client: provider,
            address: locator.address,
            program: conf.hook_manager_program.clone(),
            aleo_address,
            domain: locator.domain.clone(),
        })
    }
}

impl<C: AleoClient> HyperlaneChain for AleoMerkleTreeHook<C> {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.client.clone())
    }
}

impl<C: AleoClient> HyperlaneContract for AleoMerkleTreeHook<C> {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

impl<C: AleoClient> AleoIndexer for AleoMerkleTreeHook<C> {
    const INDEX_MAPPING: &str = "last_event_index";
    const VALUE_MAPPING: &str = "inserted_into_tree_events";

    type AleoType = InsertIntoTreeEvent;
    type Type = MerkleTreeInsertion;

    fn get_provider(&self) -> &AleoProvider<impl AleoClient> {
        &self.client
    }

    fn get_program(&self) -> &str {
        &self.program
    }

    /// Returns the latest event index of that specific block
    async fn get_latest_event_index(&self, height: u32) -> ChainResult<Option<u32>> {
        let key = HookEventIndex {
            hook: self.aleo_address,
            block_height: height,
        };
        // The latest event index for hooks is composition of block_height & hook_address
        let last_event_index = self
            .get_provider()
            .get_mapping_value(self.get_program(), Self::INDEX_MAPPING, &key)
            .await?;
        Ok(last_event_index)
    }

    /// Returns the event value of a mapping
    fn get_mapping_key<N: Network>(&self, index: u32) -> ChainResult<Plaintext<N>> {
        let str_value = format!("{{hook: {}, index: {}u32}}", self.aleo_address, index);
        Ok(Plaintext::from_str(&str_value).map_err(HyperlaneAleoError::from)?)
    }
}

#[async_trait]
impl<C: AleoClient> Indexer<MerkleTreeInsertion> for AleoMerkleTreeHook<C> {
    /// Fetch list of logs between blocks `from` and `to`, inclusive.
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        AleoIndexer::fetch_logs_in_range(self, range).await
    }

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        AleoIndexer::get_finalized_block_number(self).await
    }

    /// Fetch list of logs emitted in a transaction with the given hash.
    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        AleoIndexer::fetch_logs_by_tx_hash(self, tx_hash).await
    }
}

#[async_trait]
impl<C: AleoClient> SequenceAwareIndexer<MerkleTreeInsertion> for AleoMerkleTreeHook<C> {
    /// Return the latest finalized sequence (if any) and block number
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let (mth, height) = self
            .client
            .get_mapping_value_meta::<AleoMerkleTreeHookStruct>(
                &self.program,
                "merkle_tree_hooks",
                &self.aleo_address.to_string(),
            )
            .await?;
        Ok((Some(mth.tree.count), height))
    }
}

#[async_trait]
impl<C: AleoClient> MerkleTreeHook for AleoMerkleTreeHook<C> {
    /// Return the incremental merkle tree in storage
    ///
    /// - `reorg_period` is ignored as Aleo has a BFT consensus algorithm with instant finality.
    async fn tree(&self, _reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        let (mth, block_height) = self
            .client
            .get_mapping_value_meta::<AleoMerkleTreeHookStruct>(
                &self.program,
                "merkle_tree_hooks",
                &self.aleo_address.to_string(),
            )
            .await?;
        Ok(IncrementalMerkleAtBlock {
            tree: mth.tree.into(),
            block_height: Some(block_height.into()),
        })
    }

    /// Gets the current leaf count of the merkle tree
    ///
    /// - `reorg_period` is ignored as Aleo has a BFT consensus algorithm with instant finality.
    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let mth: AleoMerkleTreeHookStruct = self
            .client
            .get_mapping_value(&self.program, "merkle_tree_hooks", &self.aleo_address)
            .await?
            .ok_or(HyperlaneAleoError::UnknownMerkleTreeHook(
                self.aleo_address.to_string(),
            ))?;
        Ok(mth.tree.count)
    }

    /// Get the latest checkpoint.
    ///
    /// - `reorg_period` is ignored as Aleo has a BFT consensus algorithm with instant finality.
    async fn latest_checkpoint(
        &self,
        _reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        let (mth, block_height) = self
            .client
            .get_mapping_value_meta::<AleoMerkleTreeHookStruct>(
                &self.program,
                "merkle_tree_hooks",
                &self.aleo_address.to_string(),
            )
            .await?;
        Ok(CheckpointAtBlock {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: self.address,
                mailbox_domain: self.domain.id(),
                root: aleo_hash_to_h256(&mth.root),
                index: mth.tree.count.saturating_sub(1),
            },
            block_height: Some(block_height.into()),
        })
    }

    /// Get the latest checkpoint at a specific block height.
    async fn latest_checkpoint_at_block(&self, _height: u64) -> ChainResult<CheckpointAtBlock> {
        // We can't query this, instead we return the latest checkpoint
        self.latest_checkpoint(&ReorgPeriod::None).await
    }
}
