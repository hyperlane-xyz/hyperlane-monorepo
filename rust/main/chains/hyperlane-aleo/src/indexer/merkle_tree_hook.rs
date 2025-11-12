use std::{ops::RangeInclusive, str::FromStr};

use async_trait::async_trait;
use snarkvm::prelude::{Address, FromBytes, Network, Plaintext};

use hyperlane_core::{
    ChainResult, Checkpoint, CheckpointAtBlock, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, IncrementalMerkleAtBlock, Indexed, Indexer, LogMeta,
    MerkleTreeHook, MerkleTreeInsertion, ReorgPeriod, SequenceAwareIndexer, H256, H512,
};

use crate::{
    indexer::AleoIndexer, utils::u128_to_hash, AleoMerkleTreeHookStruct, AleoProvider,
    ConnectionConf, CurrentNetwork, HookEventIndex, HyperlaneAleoError, InsertIntoTreeEvent,
};

/// Aleo MerkleTreeHook Indexer
#[derive(Debug, Clone)]
pub struct AleoMerkleTreeHook {
    client: AleoProvider,
    address: H256,
    program: String,
    aleo_address: Address<CurrentNetwork>,
    domain: HyperlaneDomain,
}

impl AleoMerkleTreeHook {
    /// Creates a new Merkle Tree Hook
    pub fn new(
        provider: AleoProvider,
        locator: &ContractLocator,
        conf: &ConnectionConf,
    ) -> ChainResult<Self> {
        let aleo_address = Address::<CurrentNetwork>::from_bytes_le(locator.address.as_bytes())
            .map_err(HyperlaneAleoError::from)?;
        return Ok(Self {
            client: provider,
            address: locator.address,
            program: conf.hook_manager_program.clone(),
            aleo_address,
            domain: locator.domain.clone(),
        });
    }
}

impl HyperlaneChain for AleoMerkleTreeHook {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.client.clone())
    }
}

impl HyperlaneContract for AleoMerkleTreeHook {
    /// Address
    fn address(&self) -> H256 {
        self.address
    }
}

impl AleoIndexer for AleoMerkleTreeHook {
    const INDEX_MAPPING: &str = "last_event_index";
    const VALUE_MAPPING: &str = "inserted_into_tree_events";

    type AleoType = InsertIntoTreeEvent;
    type Type = MerkleTreeInsertion;

    fn get_client(&self) -> &AleoProvider {
        &self.client
    }

    fn get_program(&self) -> &str {
        &self.program
    }

    /// Returns the lastest event index of that specific block
    async fn get_latest_event_index(&self, height: u32) -> ChainResult<u32> {
        let key = HookEventIndex {
            hook: self.aleo_address,
            block_height: height,
        };
        // The lastest event index for hooks is composition of block_height & hook_address
        let last_event_index: u32 = self
            .get_client()
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
impl Indexer<MerkleTreeInsertion> for AleoMerkleTreeHook {
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
impl SequenceAwareIndexer<MerkleTreeInsertion> for AleoMerkleTreeHook {
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
impl MerkleTreeHook for AleoMerkleTreeHook {
    /// Return the incremental merkle tree in storage
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
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
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let mth: AleoMerkleTreeHookStruct = self
            .client
            .get_mapping_value(&self.program, "merkle_tree_hooks", &self.aleo_address)
            .await?;
        Ok(mth.tree.count)
    }

    /// Get the latest checkpoint.
    ///
    /// - `reorg_period` is how far behind the current block to query, if not specified
    ///   it will query at the latest block.
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
                root: u128_to_hash(&mth.root),
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
