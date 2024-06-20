use std::{fmt::Debug, num::NonZeroU64, ops::RangeInclusive, str::FromStr};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult, Checkpoint,
    ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider,
    Indexed, Indexer, LogMeta, MerkleTreeHook, MerkleTreeInsertion, SequenceAwareIndexer, H256,
};
use once_cell::sync::Lazy;
use tendermint::abci::EventAttribute;
use tracing::instrument;

use crate::{
    grpc::WasmProvider,
    payloads::{general, merkle_tree_hook},
    rpc::{CosmosWasmIndexer, ParsedEvent, WasmIndexer},
    utils::{
        execute_and_parse_log_futures, get_block_height_for_lag, CONTRACT_ADDRESS_ATTRIBUTE_KEY,
        CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64,
    },
    ConnectionConf, CosmosProvider, HyperlaneCosmosError, Signer,
};

#[derive(Debug, Clone)]
/// A reference to a MerkleTreeHook contract on some Cosmos chain
pub struct CosmosMerkleTreeHook {
    /// Domain
    domain: HyperlaneDomain,
    /// Contract address
    address: H256,
    /// Provider
    provider: CosmosProvider,
}

impl CosmosMerkleTreeHook {
    /// create new Cosmos MerkleTreeHook agent
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider = CosmosProvider::new(
            locator.domain.clone(),
            conf.clone(),
            Some(locator.clone()),
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
    async fn tree(&self, lag: Option<NonZeroU64>) -> ChainResult<IncrementalMerkle> {
        let payload = merkle_tree_hook::MerkleTreeRequest {
            tree: general::EmptyStruct {},
        };

        let block_height = get_block_height_for_lag(self.provider.grpc(), lag).await?;

        let data = self
            .provider
            .grpc()
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

        let block_height = get_block_height_for_lag(self.provider.grpc(), lag).await?;

        self.count_at_block(block_height).await
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        let payload = merkle_tree_hook::CheckPointRequest {
            check_point: general::EmptyStruct {},
        };

        let block_height = get_block_height_for_lag(self.provider.grpc(), lag).await?;

        let data = self
            .provider
            .grpc()
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
            .grpc()
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

const INDEX_ATTRIBUTE_KEY: &str = "index";
pub(crate) static INDEX_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(INDEX_ATTRIBUTE_KEY));

const MESSAGE_ID_ATTRIBUTE_KEY: &str = "message_id";
pub(crate) static MESSAGE_ID_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(MESSAGE_ID_ATTRIBUTE_KEY));

#[derive(Debug, Clone)]
/// A reference to a MerkleTreeHookIndexer contract on some Cosmos chain
pub struct CosmosMerkleTreeHookIndexer {
    /// The CosmosMerkleTreeHook
    merkle_tree_hook: CosmosMerkleTreeHook,
    /// Cosmwasm indexer instance
    indexer: Box<CosmosWasmIndexer>,
}

impl CosmosMerkleTreeHookIndexer {
    /// The message dispatch event type from the CW contract.
    const MERKLE_TREE_INSERTION_EVENT_TYPE: &str = "hpl_hook_merkle::post_dispatch";

    /// create new Cosmos MerkleTreeHookIndexer agent
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
        reorg_period: u32,
    ) -> ChainResult<Self> {
        let indexer = CosmosWasmIndexer::new(
            conf.clone(),
            locator.clone(),
            Self::MERKLE_TREE_INSERTION_EVENT_TYPE.into(),
            reorg_period,
        )?;

        Ok(Self {
            merkle_tree_hook: CosmosMerkleTreeHook::new(conf, locator, signer)?,
            indexer: Box::new(indexer),
        })
    }

    #[instrument(err)]
    fn merkle_tree_insertion_parser(
        attrs: &Vec<EventAttribute>,
    ) -> ChainResult<ParsedEvent<MerkleTreeInsertion>> {
        let mut contract_address: Option<String> = None;
        let mut insertion = IncompleteMerkleTreeInsertion::default();

        for attr in attrs {
            let key = attr.key.as_str();
            let value = attr.value.as_str();

            match key {
                CONTRACT_ADDRESS_ATTRIBUTE_KEY => {
                    contract_address = Some(value.to_string());
                }
                v if *CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64 == v => {
                    contract_address = Some(String::from_utf8(
                        BASE64
                            .decode(value)
                            .map_err(Into::<HyperlaneCosmosError>::into)?,
                    )?);
                }

                MESSAGE_ID_ATTRIBUTE_KEY => {
                    insertion.message_id = Some(H256::from_slice(hex::decode(value)?.as_slice()));
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
                }

                INDEX_ATTRIBUTE_KEY => {
                    insertion.leaf_index = Some(value.parse::<u32>()?);
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
                }

                _ => {}
            }
        }

        let contract_address = contract_address
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing contract_address"))?;

        Ok(ParsedEvent::new(contract_address, insertion.try_into()?))
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for CosmosMerkleTreeHookIndexer {
    /// Fetch list of logs between `range` of blocks
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let logs_futures: Vec<_> = range
            .map(|block_number| {
                let self_clone = self.clone();
                tokio::spawn(async move {
                    let logs = self_clone
                        .indexer
                        .get_logs_in_block(
                            block_number,
                            Self::merkle_tree_insertion_parser,
                            "MerkleTreeInsertionCursor",
                        )
                        .await;
                    (logs, block_number)
                })
            })
            .collect();

        execute_and_parse_log_futures(logs_futures).await
    }

    /// Get the chain's latest block number that has reached finality
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for CosmosMerkleTreeHookIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        let sequence = self
            .merkle_tree_hook
            .count_at_block(Some(tip.into()))
            .await?;

        Ok((Some(sequence), tip))
    }
}

#[derive(Default)]
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
    use hyperlane_core::H256;
    use std::str::FromStr;

    use crate::{rpc::ParsedEvent, utils::event_attributes_from_str};

    use super::*;

    #[test]
    fn test_merkle_tree_insertion_parser() {
        // Examples from https://rpc-kralum.neutron-1.neutron.org/tx_search?query=%22tx.height%20%3E=%204000000%20AND%20tx.height%20%3C=%204100000%20AND%20wasm-hpl_hook_merkle::post_dispatch._contract_address%20=%20%27neutron1e5c2qqquc86rd3q77aj2wyht40z6z3q5pclaq040ue9f5f8yuf7qnpvkzk%27%22&prove=false&page=1&per_page=100

        let expected = ParsedEvent::new(
            "neutron1e5c2qqquc86rd3q77aj2wyht40z6z3q5pclaq040ue9f5f8yuf7qnpvkzk".into(),
            MerkleTreeInsertion::new(
                4,
                H256::from_str("a21078beac8bc19770d532eed0b4ada5ef0b45992cde219979f07e3e49185384")
                    .unwrap(),
            ),
        );

        let assert_parsed_event = |attrs: &Vec<EventAttribute>| {
            let parsed_event =
                CosmosMerkleTreeHookIndexer::merkle_tree_insertion_parser(attrs).unwrap();

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
