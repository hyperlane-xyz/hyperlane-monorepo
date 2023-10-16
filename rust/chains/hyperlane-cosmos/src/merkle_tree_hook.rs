use std::{fmt::Debug, num::NonZeroU64, ops::RangeInclusive, str::FromStr};

use async_trait::async_trait;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainResult, Checkpoint, ContractLocator,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider, Indexer, LogMeta,
    MerkleTreeHook, MerkleTreeInsertion, SequenceIndexer, H256,
};
use tracing::{info, instrument};

use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    payloads::{
        general::{self, EventAttribute},
        merkle_tree_hook,
    },
    rpc::{CosmosWasmIndexer, WasmIndexer},
    ConnectionConf, CosmosProvider, Signer,
};

#[derive(Debug)]
/// A reference to a MerkleTreeHook contract on some Cosmos chain
pub struct CosmosMerkleTreeHook {
    /// Connection configuration
    _conf: ConnectionConf,
    /// Domain
    domain: HyperlaneDomain,
    /// Contract address
    address: H256,
    /// Signer
    _signer: Signer,
    /// Provider
    provider: Box<WasmGrpcProvider>,
}

impl CosmosMerkleTreeHook {
    /// create new Cosmos MerkleTreeHook agent
    pub fn new(conf: ConnectionConf, locator: ContractLocator, signer: Signer) -> Self {
        let provider = WasmGrpcProvider::new(conf.clone(), locator.clone(), signer.clone());

        Self {
            _conf: conf,
            domain: locator.domain.clone(),
            address: locator.address,
            _signer: signer,
            provider: Box::new(provider),
        }
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
        Box::new(CosmosProvider::new(self.domain.clone()))
    }
}

#[async_trait]
impl MerkleTreeHook for CosmosMerkleTreeHook {
    /// Return the incremental merkle tree in storage
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn tree(&self, lag: Option<NonZeroU64>) -> ChainResult<IncrementalMerkle> {
        let payload = merkle_tree_hook::MerkleTreeRequest {
            merkle_tree: general::EmptyStruct {},
        };

        let data = self.provider.wasm_query(payload, lag).await?;
        let response: merkle_tree_hook::MerkleTreeResponse = serde_json::from_slice(&data)?;

        let branch = response
            .branch
            .iter()
            .map(|s| s.as_str())
            .map(H256::from_str)
            .collect::<Result<Vec<H256>, _>>()
            .expect("fail to parse tree branch");

        Ok(IncrementalMerkle {
            branch: branch.try_into().unwrap(),
            count: response.count as usize,
        })
    }

    /// Gets the current leaf count of the merkle tree
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn count(&self, lag: Option<NonZeroU64>) -> ChainResult<u32> {
        let payload = merkle_tree_hook::MerkleTreeCountRequest {
            count: general::EmptyStruct {},
        };

        let data = self.provider.wasm_query(payload, lag).await?;
        let response: merkle_tree_hook::MerkleTreeCountResponse = serde_json::from_slice(&data)?;

        Ok(response.count)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        let payload = merkle_tree_hook::CheckPointRequest {
            check_point: general::EmptyStruct {},
        };

        let data = self.provider.wasm_query(payload, None).await?;
        let response: merkle_tree_hook::CheckPointResponse = serde_json::from_slice(&data)?;

        Ok(Checkpoint {
            merkle_tree_hook_address: self.address,
            mailbox_domain: self.domain.id(),
            root: response.root.parse().unwrap(),
            index: response.count,
        })
    }
}

// ------------------ Indexer ------------------

const EVENT_TYPE: &str = "post_dispatch";

#[derive(Debug)]
/// A reference to a MerkleTreeHookIndexer contract on some Cosmos chain
pub struct CosmosMerkleeTreeHookIndexer {
    /// Cosmwasm indexer instance
    indexer: Box<CosmosWasmIndexer>,
}

impl CosmosMerkleeTreeHookIndexer {
    /// create new Cosmos MerkleTreeHookIndexer agent
    pub fn new(conf: ConnectionConf, locator: ContractLocator) -> Self {
        let indexer: CosmosWasmIndexer =
            CosmosWasmIndexer::new(conf, locator, EVENT_TYPE.to_string());

        Self {
            indexer: Box::new(indexer),
        }
    }

    /// Get the parser for the indexer
    fn get_parser(&self) -> fn(attrs: Vec<EventAttribute>) -> MerkleTreeInsertion {
        |attrs: Vec<EventAttribute>| -> MerkleTreeInsertion {
            let mut message_id = H256::zero();
            let mut leaf_index: u32 = 0;

            for attr in attrs {
                let key = attr.key.as_str();
                let value = attr.value.as_str();

                match key {
                    "message_id" => {
                        message_id = H256::from_slice(hex::decode(value).unwrap().as_slice())
                    }
                    "leaf_index" => leaf_index = value.parse().unwrap(),
                    _ => {}
                }
            }

            MerkleTreeInsertion::new(leaf_index, message_id)
        }
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for CosmosMerkleeTreeHookIndexer {
    /// Fetch list of logs between `range` of blocks
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(MerkleTreeInsertion, LogMeta)>> {
        let mut result: Vec<(MerkleTreeInsertion, LogMeta)> = vec![];
        let parser = self.get_parser();

        for block_number in range {
            let logs = self.indexer.get_event_log(block_number, parser).await?;
            result.extend(logs);
        }

        Ok(result)
    }

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.latest_block_height().await
    }
}

#[async_trait]
impl SequenceIndexer<MerkleTreeInsertion> for CosmosMerkleeTreeHookIndexer {
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // TODO: implement when cosmos scraper support is implemented
        let tip = self.indexer.latest_block_height().await?;
        Ok((None, tip))
    }
}
