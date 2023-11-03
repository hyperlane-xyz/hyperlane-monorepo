use std::{fmt::Debug, num::NonZeroU64, ops::RangeInclusive, str::FromStr};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cosmrs::tendermint::abci::EventAttribute;
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, unwrap_or_none_result, ChainCommunicationError,
    ChainResult, Checkpoint, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexer, LogMeta, MerkleTreeHook, MerkleTreeInsertion, SequenceIndexer,
    H256,
};
use once_cell::sync::Lazy;
use tracing::{debug, instrument};

use crate::{
    grpc::{WasmGrpcProvider, WasmProvider},
    payloads::{
        general::{self},
        merkle_tree_hook,
    },
    rpc::{CosmosWasmIndexer, ParsedEvent, WasmIndexer},
    utils::{
        get_block_height_for_lag, CONTRACT_ADDRESS_ATTRIBUTE_KEY,
        CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64,
    },
    ConnectionConf, CosmosProvider, Signer,
};

#[derive(Debug)]
/// A reference to a MerkleTreeHook contract on some Cosmos chain
pub struct CosmosMerkleTreeHook {
    /// Domain
    domain: HyperlaneDomain,
    /// Contract address
    address: H256,
    /// Provider
    provider: Box<WasmGrpcProvider>,
}

impl CosmosMerkleTreeHook {
    /// create new Cosmos MerkleTreeHook agent
    pub fn new(conf: ConnectionConf, locator: ContractLocator, signer: Signer) -> Self {
        let provider = WasmGrpcProvider::new(conf.clone(), locator.clone(), signer.clone());

        Self {
            domain: locator.domain.clone(),
            address: locator.address,
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
            tree: general::EmptyStruct {},
        };

        let block_height = get_block_height_for_lag(&self.provider, lag).await?;

        let data = self
            .provider
            .wasm_query(
                merkle_tree_hook::MerkleTreeGenericRequest {
                    merkle_hook: payload,
                },
                block_height,
            )
            .await?;
        let response: merkle_tree_hook::MerkleTreeResponse = serde_json::from_slice(&data)?;

        let branch = response
            .branch
            .iter()
            .map(|s| s.as_str())
            .map(H256::from_str)
            .collect::<Result<Vec<H256>, _>>()?;

        let branch_res: [H256; 32] = branch.try_into().map_err(|_| {
            ChainCommunicationError::from_other_str("Failed to build merkle branch array")
        })?;

        Ok(IncrementalMerkle::new(branch_res, response.count as usize))
    }

    /// Gets the current leaf count of the merkle tree
    async fn count(&self, lag: Option<NonZeroU64>) -> ChainResult<u32> {
        let payload = merkle_tree_hook::MerkleTreeCountRequest {
            count: general::EmptyStruct {},
        };

        let block_height = get_block_height_for_lag(&self.provider, lag).await?;

        self.count_at_block(block_height).await
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        let payload = merkle_tree_hook::CheckPointRequest {
            check_point: general::EmptyStruct {},
        };

        let block_height = get_block_height_for_lag(&self.provider, lag).await?;

        let data = self
            .provider
            .wasm_query(
                merkle_tree_hook::MerkleTreeGenericRequest {
                    merkle_hook: payload,
                },
                block_height,
            )
            .await?;
        let response: merkle_tree_hook::CheckPointResponse = serde_json::from_slice(&data)?;

        Ok(Checkpoint {
            merkle_tree_hook_address: self.address,
            mailbox_domain: self.domain.id(),
            root: response.root.parse()?,
            index: response.count,
        })
    }
}

impl CosmosMerkleTreeHook {
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn count_at_block(&self, block_height: Option<u64>) -> ChainResult<u32> {
        let payload = merkle_tree_hook::MerkleTreeCountRequest {
            count: general::EmptyStruct {},
        };

        let data = self
            .provider
            .wasm_query(
                merkle_tree_hook::MerkleTreeGenericRequest {
                    merkle_hook: payload,
                },
                block_height,
            )
            .await?;
        let response: merkle_tree_hook::MerkleTreeCountResponse = serde_json::from_slice(&data)?;

        Ok(response.count)
    }
}

// ------------------ Indexer ------------------

const EVENT_TYPE: &str = "hpl_hook_merkle::post_dispatch";

const INDEX_ATTRIBUTE_KEY: &str = "index";
pub(crate) static INDEX_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(CONTRACT_ADDRESS_ATTRIBUTE_KEY));

const MESSAGE_ID_ATTRIBUTE_KEY: &str = "message_id";
pub(crate) static MESSAGE_ID_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(CONTRACT_ADDRESS_ATTRIBUTE_KEY));

#[derive(Debug)]
/// A reference to a MerkleTreeHookIndexer contract on some Cosmos chain
pub struct CosmosMerkleTreeHookIndexer {
    /// The CosmosMerkleTreeHook
    merkle_tree_hook: CosmosMerkleTreeHook,
    /// Cosmwasm indexer instance
    indexer: Box<CosmosWasmIndexer>,
}

impl CosmosMerkleTreeHookIndexer {
    /// create new Cosmos MerkleTreeHookIndexer agent
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Signer,
        reorg_period: u32,
    ) -> ChainResult<Self> {
        let indexer = CosmosWasmIndexer::new(
            conf.clone(),
            locator.clone(),
            EVENT_TYPE.to_string(),
            reorg_period,
        )?;

        Ok(Self {
            merkle_tree_hook: CosmosMerkleTreeHook::new(conf, locator, signer),
            indexer: Box::new(indexer),
        })
    }

    fn merkle_tree_insertion_parser(
        attrs: &Vec<EventAttribute>,
    ) -> ChainResult<Option<ParsedEvent<MerkleTreeInsertion>>> {
        let mut contract_address: Option<String> = None;
        let mut leaf_index: Option<u32> = None;
        let mut message_id: Option<H256> = None;

        for attr in attrs {
            let key = attr.key.as_str();
            let value = attr.value.as_str();

            match key {
                CONTRACT_ADDRESS_ATTRIBUTE_KEY => {
                    contract_address = Some(value.to_string());
                }
                v if &*CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64 == v => {
                    contract_address = Some(String::from_utf8(BASE64.decode(value)?)?);
                }

                MESSAGE_ID_ATTRIBUTE_KEY => {
                    message_id = Some(H256::from_slice(hex::decode(value)?.as_slice()));
                }
                v if &*MESSAGE_ID_ATTRIBUTE_KEY_BASE64 == v => {
                    message_id = Some(H256::from_slice(
                        hex::decode(String::from_utf8(BASE64.decode(value)?)?)?.as_slice(),
                    ));
                }

                INDEX_ATTRIBUTE_KEY => {
                    leaf_index = Some(value.parse::<u32>()?);
                }
                v if &*INDEX_ATTRIBUTE_KEY_BASE64 == v => {
                    leaf_index = Some(String::from_utf8(BASE64.decode(value)?)?.parse()?);
                }

                _ => {}
            }
        }

        let contract_address = unwrap_or_none_result!(
            contract_address,
            debug!("No contract address found in event attributes")
        );
        let leaf_index = unwrap_or_none_result!(
            leaf_index,
            debug!("No leaf index found in event attributes")
        );
        let message_id = unwrap_or_none_result!(
            message_id,
            debug!("No message id found in event attributes")
        );

        Ok(Some(ParsedEvent::new(
            contract_address,
            MerkleTreeInsertion::new(leaf_index, message_id),
        )))
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for CosmosMerkleTreeHookIndexer {
    /// Fetch list of logs between `range` of blocks
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(MerkleTreeInsertion, LogMeta)>> {
        let result = self
            .indexer
            .get_range_event_logs(range, Self::merkle_tree_insertion_parser)
            .await?;

        Ok(result)
    }

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceIndexer<MerkleTreeInsertion> for CosmosMerkleTreeHookIndexer {
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        let sequence = self
            .merkle_tree_hook
            .count_at_block(Some(tip.into()))
            .await?;

        Ok((Some(sequence), tip))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
}
