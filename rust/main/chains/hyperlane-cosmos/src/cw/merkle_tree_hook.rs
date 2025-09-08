use std::{fmt::Debug, ops::RangeInclusive, str::FromStr};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cometbft::abci::EventAttribute;
use once_cell::sync::Lazy;
use tracing::{debug, info, instrument};

use hyperlane_core::accumulator::incremental::IncrementalMerkle;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, Checkpoint, CheckpointAtBlock, ContractLocator,
    HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider,
    IncrementalMerkleAtBlock, Indexed, Indexer, LogMeta, MerkleTreeHook, MerkleTreeInsertion,
    ReorgPeriod, SequenceAwareIndexer, H256, H512,
};

use super::payloads::{general, merkle_tree_hook};
use super::CwQueryClient;
use crate::indexer::{CosmosEventIndexer, ParsedEvent};
use crate::utils::{CONTRACT_ADDRESS_ATTRIBUTE_KEY, CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64};
use crate::{CosmosAddress, CosmosProvider, HyperlaneCosmosError, RpcProvider};

#[derive(Debug, Clone)]
/// A reference to a MerkleTreeHook contract on some Cosmos chain
pub struct CwMerkleTreeHook {
    /// Domain
    domain: HyperlaneDomain,
    /// Contract address
    address: H256,
    /// Provider
    provider: CosmosProvider<CwQueryClient>,
}

impl CwMerkleTreeHook {
    /// create new Cosmos MerkleTreeHook agent
    pub fn new(
        provider: CosmosProvider<CwQueryClient>,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(Self {
            domain: locator.domain.clone(),
            address: locator.address,
            provider,
        })
    }
}

impl HyperlaneContract for CwMerkleTreeHook {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for CwMerkleTreeHook {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl MerkleTreeHook for CwMerkleTreeHook {
    /// Return the incremental merkle tree in storage
    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        let payload = merkle_tree_hook::MerkleTreeRequest {
            tree: general::EmptyStruct {},
        };

        let block_height = self.provider.reorg_to_height(reorg_period).await?;

        let data = self
            .provider
            .query()
            .wasm_query(
                merkle_tree_hook::MerkleTreeGenericRequest {
                    merkle_hook: payload,
                },
                Some(block_height),
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

        let tree = IncrementalMerkle::new(branch_res, response.count as usize);
        Ok(IncrementalMerkleAtBlock {
            tree,
            block_height: Some(block_height),
        })
    }

    /// Gets the current leaf count of the merkle tree
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let block_height = self.provider.reorg_to_height(reorg_period).await?;

        self.count_at_block(block_height).await
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        let block_height = self.provider.reorg_to_height(reorg_period).await?;
        self.latest_checkpoint_at_block(block_height).await
    }

    /// Get the latest checkpoint at a specific block height.
    async fn latest_checkpoint_at_block(&self, height: u64) -> ChainResult<CheckpointAtBlock> {
        let payload = merkle_tree_hook::CheckPointRequest {
            check_point: general::EmptyStruct {},
        };
        let data = self
            .provider
            .query()
            .wasm_query(
                merkle_tree_hook::MerkleTreeGenericRequest {
                    merkle_hook: payload,
                },
                Some(height),
            )
            .await?;
        let response: merkle_tree_hook::CheckPointResponse = serde_json::from_slice(&data)?;

        Ok(CheckpointAtBlock {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: self.address,
                mailbox_domain: self.domain.id(),
                root: response.root.parse()?,
                index: response.count,
            },
            block_height: Some(height),
        })
    }
}

impl CwMerkleTreeHook {
    #[instrument(level = "debug", err, ret, skip(self))]
    async fn count_at_block(&self, block_height: u64) -> ChainResult<u32> {
        let payload = merkle_tree_hook::MerkleTreeCountRequest {
            count: general::EmptyStruct {},
        };

        let data = self
            .provider
            .query()
            .wasm_query(
                merkle_tree_hook::MerkleTreeGenericRequest {
                    merkle_hook: payload,
                },
                Some(block_height),
            )
            .await?;
        let response: merkle_tree_hook::MerkleTreeCountResponse = serde_json::from_slice(&data)?;

        Ok(response.count)
    }
}

// ------------------ Indexer ------------------

const INDEX_ATTRIBUTE_KEY: &str = "index";
pub(crate) static INDEX_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(INDEX_ATTRIBUTE_KEY));

const MESSAGE_ID_ATTRIBUTE_KEY: &str = "message_id";
pub(crate) static MESSAGE_ID_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(MESSAGE_ID_ATTRIBUTE_KEY));

#[derive(Debug, Clone)]
/// A reference to a MerkleTreeHookIndexer contract on some Cosmos chain
pub struct CwMerkleTreeHookIndexer {
    /// The CosmosMerkleTreeHook
    merkle_tree_hook: CwMerkleTreeHook,
    /// Cosmwasm RPC provider instance
    provider: CosmosProvider<CwQueryClient>,
    /// Address of the contract
    address: H256,
}

impl CwMerkleTreeHookIndexer {
    /// The message dispatch event type from the CW contract.
    pub const MERKLE_TREE_INSERTION_EVENT_TYPE: &'static str =
        "wasm-hpl_hook_merkle::post_dispatch";

    /// create new Cosmos MerkleTreeHookIndexer agent
    pub fn new(
        provider: CosmosProvider<CwQueryClient>,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(Self {
            merkle_tree_hook: CwMerkleTreeHook::new(provider.clone(), locator.clone())?,
            address: locator.address,
            provider,
        })
    }

    #[instrument(err)]
    fn merkle_tree_insertion_parser(
        attrs: &[EventAttribute],
    ) -> ChainResult<ParsedEvent<MerkleTreeInsertion>> {
        debug!(
            ?attrs,
            "parsing merkle tree insertion from event attributes",
        );

        let mut contract_address: Option<String> = None;
        let mut insertion = IncompleteMerkleTreeInsertion::default();

        for attr in attrs {
            match attr {
                EventAttribute::V037(a) => {
                    let key = a.key.as_str();
                    let value = a.value.as_str();

                    match key {
                        CONTRACT_ADDRESS_ATTRIBUTE_KEY => {
                            contract_address = Some(value.to_string());
                            debug!(?contract_address, "parsed contract address from plain text");
                        }
                        v if *CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64 == v => {
                            contract_address = Some(String::from_utf8(
                                BASE64
                                    .decode(value)
                                    .map_err(Into::<HyperlaneCosmosError>::into)?,
                            )?);
                            debug!(?contract_address, "parsed contract address from base64");
                        }

                        MESSAGE_ID_ATTRIBUTE_KEY => {
                            insertion.message_id =
                                Some(H256::from_slice(hex::decode(value)?.as_slice()));
                            debug!(message_id = ?insertion.message_id, "parsed message_id from plain text");
                        }
                        v if *MESSAGE_ID_ATTRIBUTE_KEY_BASE64 == v => {
                            insertion.message_id = Some(H256::from_slice(
                                hex::decode(String::from_utf8(
                                    BASE64
                                        .decode(value)
                                        .map_err(Into::<HyperlaneCosmosError>::into)?,
                                )?)?
                                .as_slice(),
                            ));
                            debug!(message_id = ?insertion.message_id, "parsed message_id from base64");
                        }

                        INDEX_ATTRIBUTE_KEY => {
                            insertion.leaf_index = Some(value.parse::<u32>()?);
                            debug!(leaf_index = ?insertion.leaf_index, "parsed leaf_index from plain text");
                        }
                        v if *INDEX_ATTRIBUTE_KEY_BASE64 == v => {
                            insertion.leaf_index = Some(
                                String::from_utf8(
                                    BASE64
                                        .decode(value)
                                        .map_err(Into::<HyperlaneCosmosError>::into)?,
                                )?
                                .parse()?,
                            );
                            debug!(leaf_index = ?insertion.leaf_index, "parsed leaf_index from base64");
                        }

                        unknown => {
                            debug!(?unknown, "unknown attribute");
                        }
                    }
                }

                EventAttribute::V034(_a) => {
                    unimplemented!();
                }
            }
        }

        let contract_address = contract_address
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing contract_address"))?;

        debug!(
            ?contract_address,
            ?insertion,
            "parsed contract address and insertion",
        );

        let event = ParsedEvent::new(
            CosmosAddress::from_str(&contract_address)?.digest(),
            insertion.try_into()?,
        );

        info!(?event, "parsed event");

        Ok(event)
    }
}

impl CosmosEventIndexer<MerkleTreeInsertion> for CwMerkleTreeHookIndexer {
    fn target_type() -> String {
        Self::MERKLE_TREE_INSERTION_EVENT_TYPE.to_owned()
    }

    fn provider(&self) -> &RpcProvider {
        self.provider.rpc()
    }

    #[doc = " parses the event attributes to the target type"]
    fn parse(
        &self,
        attributes: &[EventAttribute],
    ) -> ChainResult<ParsedEvent<MerkleTreeInsertion>> {
        Self::merkle_tree_insertion_parser(attributes)
    }

    #[doc = " address for the given module that will be indexed"]
    fn address(&self) -> &H256 {
        &self.address
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for CwMerkleTreeHookIndexer {
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
impl SequenceAwareIndexer<MerkleTreeInsertion> for CwMerkleTreeHookIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = CosmosEventIndexer::get_finalized_block_number(self).await?;
        let sequence = self.merkle_tree_hook.count_at_block(tip.into()).await?;

        Ok((Some(sequence), tip))
    }
}

#[derive(Default, Debug)]
struct IncompleteMerkleTreeInsertion {
    leaf_index: Option<u32>,
    message_id: Option<H256>,
}

impl TryInto<MerkleTreeInsertion> for IncompleteMerkleTreeInsertion {
    type Error = ChainCommunicationError;

    fn try_into(self) -> Result<MerkleTreeInsertion, Self::Error> {
        let leaf_index = self
            .leaf_index
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing leaf_index"))?;
        let message_id = self
            .message_id
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing message_id"))?;

        Ok(MerkleTreeInsertion::new(leaf_index, message_id))
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use hyperlane_core::H256;

    use crate::indexer::ParsedEvent;
    use crate::utils::event_attributes_from_str;
    use crate::CosmosAddress;

    use super::*;

    #[test]
    fn test_merkle_tree_insertion_parser() {
        // Examples from https://rpc-kralum.neutron-1.neutron.org/tx_search?query=%22tx.height%20%3E=%204000000%20AND%20tx.height%20%3C=%204100000%20AND%20wasm-hpl_hook_merkle::post_dispatch._contract_address%20=%20%27neutron1e5c2qqquc86rd3q77aj2wyht40z6z3q5pclaq040ue9f5f8yuf7qnpvkzk%27%22&prove=false&page=1&per_page=100
        let contract_address = CosmosAddress::from_str(
            "neutron1e5c2qqquc86rd3q77aj2wyht40z6z3q5pclaq040ue9f5f8yuf7qnpvkzk",
        );
        assert!(contract_address.is_ok());

        let expected = ParsedEvent::new(
            contract_address.unwrap().digest(),
            MerkleTreeInsertion::new(
                4,
                H256::from_str("a21078beac8bc19770d532eed0b4ada5ef0b45992cde219979f07e3e49185384")
                    .unwrap(),
            ),
        );

        let assert_parsed_event = |attrs: &Vec<EventAttribute>| {
            let parsed_event =
                CwMerkleTreeHookIndexer::merkle_tree_insertion_parser(attrs).unwrap();

            assert_eq!(parsed_event, expected);
        };

        // Non-base64 version
        let non_base64_attrs = event_attributes_from_str(
            r#"[{"key":"_contract_address","value":"neutron1e5c2qqquc86rd3q77aj2wyht40z6z3q5pclaq040ue9f5f8yuf7qnpvkzk","index":true},{"key":"index","value":"4","index":true},{"key":"message_id","value":"a21078beac8bc19770d532eed0b4ada5ef0b45992cde219979f07e3e49185384","index":true}]"#,
        );
        assert_parsed_event(&non_base64_attrs);

        // Base64 version
        let base64_attrs = event_attributes_from_str(
            r#"[{"key":"X2NvbnRyYWN0X2FkZHJlc3M=","value":"bmV1dHJvbjFlNWMycXFxdWM4NnJkM3E3N2FqMnd5aHQ0MHo2ejNxNXBjbGFxMDQwdWU5ZjVmOHl1ZjdxbnB2a3pr","index":true},{"key":"aW5kZXg=","value":"NA==","index":true},{"key":"bWVzc2FnZV9pZA==","value":"YTIxMDc4YmVhYzhiYzE5NzcwZDUzMmVlZDBiNGFkYTVlZjBiNDU5OTJjZGUyMTk5NzlmMDdlM2U0OTE4NTM4NA==","index":true}]"#,
        );
        assert_parsed_event(&base64_attrs);
    }
}
