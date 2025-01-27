use std::{cmp::max, ops::RangeInclusive};

use async_trait::async_trait;
use base64::{engine::general_purpose, Engine};
use num_traits::ToPrimitive;
use tonlib_core::{
    cell::{
        dict::predefined_readers::{key_reader_u8, val_reader_uint},
        BagOfCells,
    },
    TonAddress,
};
use tracing::{info, warn};

use hyperlane_core::{
    accumulator::{incremental::IncrementalMerkle, TREE_DEPTH},
    ChainCommunicationError, ChainResult, Checkpoint, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, Indexed, Indexer, LogMeta, MerkleTreeHook,
    MerkleTreeInsertion, ReorgPeriod, SequenceAwareIndexer, H256,
};

use crate::{
    client::provider::TonProvider, error::HyperlaneTonError, run_get_method::StackValue,
    ton_api_center::TonApiCenter, utils::conversion::ConversionUtils,
};

#[derive(Debug, Clone)]
/// A reference to a MerkleTreeHook contract on some TON chain
pub struct TonMerkleTreeHook {
    /// Domain
    provider: TonProvider,
    /// Contract address
    address: TonAddress,
}

impl TonMerkleTreeHook {
    /// Create a new TonMerkleTreeHook instance
    pub fn new(provider: TonProvider, address: TonAddress) -> ChainResult<Self> {
        Ok(Self { provider, address })
    }
}

impl HyperlaneContract for TonMerkleTreeHook {
    fn address(&self) -> H256 {
        ConversionUtils::ton_address_to_h256(&self.address)
    }
}

impl HyperlaneChain for TonMerkleTreeHook {
    fn domain(&self) -> &HyperlaneDomain {
        &self.provider.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.provider()
    }
}

#[async_trait]
impl MerkleTreeHook for TonMerkleTreeHook {
    async fn tree(&self, _reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkle> {
        let response = self
            .provider
            .run_get_method(self.address.to_string(), "get_tree".to_string(), None)
            .await
            .map_err(|e| HyperlaneTonError::ApiInvalidResponse(format!("Error:{:?}", e)))?;
        if response.exit_code != 0 {
            return Err(ChainCommunicationError::from(
                HyperlaneTonError::ApiRequestFailed("Non-zero exit code in response".to_string()),
            ));
        }

        let tree_stack_item = response.stack.get(0).ok_or_else(|| {
            HyperlaneTonError::FailedToParseStackItem(
                "Response stack is empty or missing tree item".to_string(),
            )
        })?;
        let count_stack_item = response.stack.get(1).ok_or_else(|| {
            HyperlaneTonError::FailedToParseStackItem(
                "Response stack is empty or missing count item".to_string(),
            )
        })?;

        let count = match &count_stack_item.value {
            StackValue::String(num) => u8::from_str_radix(num.trim_start_matches("0x"), 16)
                .map_err(|e| {
                    HyperlaneTonError::ParsingError(format!(
                        "Failed to parse String '{}' to u8: {:?}",
                        num, e
                    ))
                })?,
            _ => {
                return Err(HyperlaneTonError::ParsingError(
                    "Unexpected stack value type for count".to_string(),
                )
                .into());
            }
        };
        info!("count:{:?}", count);

        let tree_boc = match &tree_stack_item.value {
            StackValue::String(boc) => boc,
            StackValue::List(list) if list.is_empty() => {
                warn!("Response stack contains empty tree list");

                let branch = [H256::zero(); TREE_DEPTH];
                return Ok(IncrementalMerkle {
                    branch,
                    count: count as usize,
                });
            }
            _ => {
                return Err(HyperlaneTonError::ParsingError(
                    "Unexpected stack value type for tree".to_string(),
                )
                .into());
            }
        };

        let cell_boc_decoded = general_purpose::STANDARD.decode(tree_boc).map_err(|e| {
            HyperlaneTonError::ParsingError(format!("Failed to decode tree BOC: {:?}", e))
        })?;

        let boc = BagOfCells::parse(&cell_boc_decoded).map_err(|e| {
            HyperlaneTonError::ParsingError(format!("Failed to parse BOC: {:?}", e))
        })?;
        let cell = boc.single_root().map_err(|e| {
            HyperlaneTonError::ParsingError(format!("Failed to get root cell: {:?}", e))
        })?;

        let dict = cell
            .parser()
            .load_dict_data(8, key_reader_u8, val_reader_uint)
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                    "Failed to parse dictionary: {}",
                    e
                )))
            })?;
        info!("Dict:{:?} dict len:{:?}", dict, dict.len());

        let mut branch = [H256::zero(); TREE_DEPTH];
        assert_eq!(
            dict.len(),
            TREE_DEPTH,
            "The length of the dictionary is {}, but it should be {}",
            dict.len(),
            TREE_DEPTH
        );
        dict.iter().for_each(|(key, hash)| {
            let size = *key as usize;

            if size <= TREE_DEPTH {
                let mut padded_hash = [0u8; 32];
                let hash_bytes = hash.to_bytes_be();
                padded_hash[32 - hash_bytes.len()..].copy_from_slice(&hash_bytes);
                branch[size] = H256::from_slice(&padded_hash);
            } else {
                warn!("Unexpected depth: {}, skipping...", size)
            }
        });

        Ok(IncrementalMerkle {
            branch,
            count: count as usize,
        })
    }

    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let response = self
            .provider
            .run_get_method(self.address.to_string(), "get_count".to_string(), None)
            .await
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                    "run_get_method failed: {:?}",
                    e
                )))
            })?;

        ConversionUtils::parse_stack_item_to_u32(&response.stack, 0).map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Failed to parse count from stack: {:?}",
                e
            )))
        })
    }
    async fn latest_checkpoint(&self, _reorg_period: &ReorgPeriod) -> ChainResult<Checkpoint> {
        let response = self
            .provider
            .run_get_method(
                self.address.to_string(),
                "get_latest_checkpoint".to_string(),
                None,
            )
            .await
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to get response: {:?}",
                    e
                )))
            })?;

        let stack = &response.stack;

        if stack.len() < 2 {
            return Err(ChainCommunicationError::from(
                HyperlaneTonError::ApiInvalidResponse(
                    "Stack does not contain enough elements".to_string(),
                ),
            ));
        }

        let root = ConversionUtils::parse_stack_item_biguint(stack, 0, "root")?;
        let index = ConversionUtils::parse_stack_item_to_u32(stack, 1)?;

        Ok(Checkpoint {
            merkle_tree_hook_address: ConversionUtils::ton_address_to_h256(&self.address.clone()),
            mailbox_domain: self.domain().id(),
            root: H256::from_slice(root.to_bytes_be().as_slice()),
            index,
        })
    }
}

#[derive(Debug, Clone)]
pub struct TonMerkleTreeHookIndexer {
    #[allow(dead_code)]
    merkle_tree_hook_address: TonAddress,
    provider: TonProvider,
}

impl TonMerkleTreeHookIndexer {
    pub fn new(address: TonAddress, provider: TonProvider) -> ChainResult<Self> {
        Ok(Self {
            merkle_tree_hook_address: address,
            provider,
        })
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for TonMerkleTreeHookIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        let start_block = max(*range.start(), 1);
        let end_block = max(*range.end(), 1);

        info!(
            "fetch_logs_in_range in MerkleTreeHook start:{:?} end:{:?}",
            start_block, end_block
        );
        let timestamps = self
            .provider
            .fetch_blocks_timestamps(vec![start_block, end_block])
            .await?;

        let start_utime = *timestamps.get(0).ok_or_else(|| {
            ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(
                "Failed to get start_utime".to_string(),
            ))
        })?;
        let end_utime = *timestamps.get(1).ok_or_else(|| {
            ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(
                "Failed to get end_utime".to_string(),
            ))
        })?;

        let messages = self
            .provider
            .get_messages(
                None,
                None,
                Some(self.merkle_tree_hook_address.to_hex().to_string()),
                Some("null".to_string()),
                None,
                Some(start_utime),
                Some(end_utime),
                None,
                None,
                None,
                None,
                None,
                Some("desc".to_string()),
            )
            .await
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to fetch messages in range: {:?}",
                    e
                )))
            })?;

        let events: Vec<(Indexed<MerkleTreeInsertion>, LogMeta)> = messages
            .messages
            .iter()
            .filter_map(|message| {
                let cell = ConversionUtils::parse_root_cell_from_boc(&message.message_content.body)
                    .map_err(|e| {
                        warn!("Failed to parse root cell from BOC: {:?}", e);
                        e
                    })
                    .ok()?;

                let mut parser = cell.parser();

                let message_id = parser
                    .load_uint(256)
                    .map_err(|e| {
                        warn!("Failed to load_uint message_id: {:?}", e);
                        e
                    })
                    .ok()?;
                let message_id_h256 = H256::from_slice(message_id.to_bytes_be().as_slice());

                let index = parser
                    .load_uint(32)
                    .map_err(|e| {
                        warn!("Failed to load_uint index: {:?}", e);
                        e
                    })
                    .ok()?;

                let index_u32 = index
                    .to_u32()
                    .ok_or_else(|| {
                        warn!("Index value is too large for u32");
                    })
                    .ok()?;

                let merkle_tree_insertion = MerkleTreeInsertion::new(index_u32, message_id_h256);

                let log_meta = LogMeta {
                    address: ConversionUtils::ton_address_to_h256(&self.merkle_tree_hook_address),
                    block_number: Default::default(),
                    block_hash: Default::default(),
                    transaction_id: Default::default(),
                    transaction_index: 0,
                    log_index: Default::default(),
                };

                Some((Indexed::new(merkle_tree_insertion), log_meta))
            })
            .collect();

        info!("events in merkleTreeHook:{:?}", events);
        Ok(events)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider.get_finalized_block().await.map_err(|e| {
            HyperlaneTonError::ApiRequestFailed(format!(
                "Failed to fetch finalized block number for TonMailboxIndexer: {:?}",
                e
            ))
            .into()
        })
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for TonMerkleTreeHookIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        let response = self
            .provider
            .run_get_method(
                self.merkle_tree_hook_address.to_string(),
                "get_count".to_string(),
                None,
            )
            .await
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                    "run_get_method failed for 'get_count': {:?}",
                    e
                )))
            })?;

        let sequence =
            ConversionUtils::parse_stack_item_to_u32(&response.stack, 0).map_err(|e| {
                HyperlaneTonError::ParsingError(format!(
                    "Failed to parse stack item to u32 for sequence:{:?}",
                    e
                ))
            })?;

        Ok((Some(sequence), tip))
    }
}
