use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, FixedPointNumber, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, LogMeta, Mailbox,
    ReorgPeriod, SequenceAwareIndexer, TxCostEstimate, TxOutcome, H256, U256,
};
use num_bigint::BigUint;
use std::{
    fmt::{Debug, Formatter},
    ops::RangeInclusive,
    time::SystemTime,
};
use tracing::{error, info, warn};

use tonlib_core::cell::TonCellError;
use tonlib_core::message::{InternalMessage, TonMessage};
use tonlib_core::{
    cell::{ArcCell, BagOfCells, Cell, CellBuilder},
    message::{CommonMsgInfo, TransferMessage},
    TonAddress,
};

use crate::client::provider::TonProvider;
use crate::signer::signer::TonSigner;
use crate::traits::ton_api_center::TonApiCenter;
use crate::utils::conversion::ConversionUtils;
use base64::{engine::general_purpose, Engine};
use tonlib_core::cell::dict::predefined_readers::{key_reader_uint, val_reader_cell};

pub struct TonMailbox {
    pub mailbox_address: TonAddress,
    pub provider: TonProvider,
    pub signer: TonSigner,
    pub workchain: i32, // -1 or 0 now
}
impl TonMailbox {
    pub fn new(
        mailbox_address: TonAddress,
        provider: TonProvider,
        workchain: i32,
        signer: TonSigner,
    ) -> Self {
        Self {
            mailbox_address,
            provider,
            workchain,
            signer,
        }
    }
}

impl HyperlaneContract for TonMailbox {
    fn address(&self) -> H256 {
        ConversionUtils::ton_address_to_h256(&self.mailbox_address)
    }
}

impl HyperlaneChain for TonMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        &self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.provider()
    }
}

impl Debug for TonMailbox {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ton mailbox:")
            .field("mailbox address:", &self.mailbox_address.to_hex())
            .field("provider", &self.provider)
            .field("wallet:", &self.signer.address.to_hex())
            .finish()
    }
}
impl TonMailbox {
    const PROCESS_OPCODE: u32 = 0xea81949bu32;
    const PROCESS_INIT: u32 = 0xba35fd5f;
}
#[async_trait]
impl Mailbox for TonMailbox {
    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let response = self
            .provider
            .run_get_method(
                self.mailbox_address.to_string(),
                "get_nonce".to_string(),
                Some(vec![]),
            )
            .await
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to run get_nonce method: {:?}",
                    e
                ))
            })?;

        ConversionUtils::parse_stack_item_to_u32(&response.stack, 0).map_err(|e| {
            ChainCommunicationError::CustomError(format!(
                "Failed to parse stack item to u32: {:?}",
                e
            ))
        })
    }

    //
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let response = self
            .provider
            .run_get_method(
                self.mailbox_address.to_hex(),
                "get_deliveries".to_string(),
                None,
            )
            .await
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Error calling run_get_method: {:?}",
                    e
                ))
            })?;

        let stack_item = response.stack.first().ok_or_else(|| {
            ChainCommunicationError::CustomError("No stack item found in response".to_string())
        })?;

        if stack_item.r#type != "cell" {
            return Err(ChainCommunicationError::CustomError(format!(
                "Unexpected stack item type: {:?}",
                stack_item.r#type
            )));
        };
        let root_cell =
            ConversionUtils::parse_root_cell_from_boc(&stack_item.value).map_err(|e| {
                ChainCommunicationError::CustomError(format!("Failed to parse root cell: {:?}", e))
            })?;

        let parsed_dict = root_cell
            .parser()
            .load_dict(256, key_reader_uint, val_reader_cell)
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to load dictionary from root cell: {:?}",
                    e
                ))
            })?;

        Ok(parsed_dict
            .iter()
            .any(|(key, _)| BigUint::from_bytes_be(id.as_bytes()) == *key))
    }

    async fn default_ism(&self) -> ChainResult<H256> {
        let response = self
            .provider
            .run_get_method(
                self.mailbox_address.to_hex(),
                "get_default_ism".to_string(),
                None,
            )
            .await
            .map_err(|_| {
                ChainCommunicationError::CustomError(
                    "Failed to get default ISM response".to_string(),
                )
            })?;

        let stack = response
            .stack
            .first()
            .ok_or_else(|| ChainCommunicationError::CustomError("No data in stack".to_string()))?;

        if stack.r#type != "cell" {
            return Err(ChainCommunicationError::CustomError(
                "Unexpected data type in stack, expected cell".to_string(),
            ));
        }

        let ism_address = ConversionUtils::parse_address_from_boc(&stack.value)
            .await
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to parse address from BOC: {:?}",
                    e
                ))
            })?;

        Ok(ConversionUtils::ton_address_to_h256(&ism_address))
    }

    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let recipient_address = ConversionUtils::h256_to_ton_address(&recipient, self.workchain);

        let recipient_response = self
            .provider
            .run_get_method(recipient_address.to_hex(), "get_ism".to_string(), None)
            .await;

        let response = match recipient_response {
            Ok(response) => response,
            Err(_) => self
                .provider
                .run_get_method(
                    self.mailbox_address.to_hex(),
                    "get_default_ism".to_string(),
                    None,
                )
                .await
                .map_err(|e| {
                    ChainCommunicationError::CustomError(format!(
                        "Error calling run_get_method for mailbox: {:?}",
                        e
                    ))
                })?,
        };

        let stack = response.stack.first().ok_or_else(|| {
            ChainCommunicationError::CustomError("No data found in the response stack".to_string())
        })?;

        if stack.r#type != "cell" {
            return Err(ChainCommunicationError::CustomError(format!(
                "Unexpected data type in stack: expected 'cell', got '{}'",
                stack.r#type
            )));
        }

        let recipient_ism = ConversionUtils::parse_address_from_boc(&stack.value)
            .await
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to parse address from BOC: {:?}",
                    e
                ))
            })?;

        Ok(ConversionUtils::ton_address_to_h256(&recipient_ism))
    }

    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let message_cell = ConversionUtils::build_hyperlane_message_cell(message).map_err(|e| {
            ChainCommunicationError::ParseError {
                msg: format!("Failed to parse HyperlaneMessage to Ton Cell:{:?}", e),
            }
        })?;

        let metadata_cell = ConversionUtils::metadata_to_cell(metadata).map_err(|e| {
            ChainCommunicationError::ParseError {
                msg: format!("Failed to parse metadata to Ton Cell:{:?}", e),
            }
        })?;

        let query_id = 1; // it is not currently used in the contract
        let block_number = 1;

        let msg = build_message(
            TonMailbox::PROCESS_OPCODE,
            ArcCell::new(message_cell),
            ArcCell::new(metadata_cell),
            query_id,
            block_number,
        )
        .map_err(|e| {
            ChainCommunicationError::CustomError(format!("Failed to build message: {:?}", e))
        })?;

        let common_msg_info = CommonMsgInfo::InternalMessage(InternalMessage {
            ihr_disabled: false,
            bounce: false,
            bounced: false,
            src: self.signer.address.clone(),
            dest: self.mailbox_address.clone(),
            value: BigUint::from(100000000u32),
            ihr_fee: Default::default(),
            fwd_fee: Default::default(),
            created_lt: 0,
            created_at: 0,
        });
        let transfer_message = TransferMessage {
            common_msg_info,
            state_init: None,
            data: Some(ArcCell::new(msg.clone())),
        }
        .build()
        .map_err(|e| {
            ChainCommunicationError::CustomError(format!(
                "Failed to create transfer message: {:?}",
                e
            ))
        })?;

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!("Failed to get current time: {:?}", e))
            })?
            .as_secs() as u32;

        let seqno = self
            .provider
            .get_wallet_states(self.signer.address.to_hex())
            .await
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!("Failed to get wallet state: {:?}", e))
            })?
            .wallets
            .get(0)
            .ok_or_else(|| ChainCommunicationError::CustomError("No wallet found".to_string()))?
            .seqno as u32;

        let message = self
            .signer
            .wallet
            .create_external_message(
                now + 60,
                seqno,
                vec![ArcCell::new(transfer_message.clone())],
                false,
            )
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to create external message: {:?}",
                    e
                ))
            })?;

        let boc = BagOfCells::from_root(message.clone())
            .serialize(true)
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!("Failed to serialize BOC: {:?}", e))
            })?;

        let boc_str = general_purpose::STANDARD.encode(&boc);
        info!("create_external_message:{:?}", boc_str);

        let tx = self.provider.send_message(boc_str).await.map_err(|e| {
            ChainCommunicationError::CustomError(format!(
                "Failed to send message in provider{:?}",
                e
            ))
        })?;

        info!("Tx hash:{:?}", tx.message_hash);

        self.provider.wait_for_transaction(tx.message_hash).await
    }

    async fn process_estimate_costs(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        Ok(TxCostEstimate {
            gas_limit: U256::zero(),
            gas_price: FixedPointNumber::zero(),
            l2_gas_limit: None,
        })
    }

    fn process_calldata(&self, _message: &HyperlaneMessage, _metadata: &[u8]) -> Vec<u8> {
        todo!()
    }
}

#[derive(Debug)]
pub struct TonMailboxIndexer {
    pub mailbox: TonMailbox,
}

#[async_trait]
impl Indexer<HyperlaneMessage> for TonMailboxIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let start_block = *range.start();
        let end_block = *range.end();

        let fetch_block_info = |block: u32| async move {
            self.mailbox
                .provider
                .get_blocks(
                    -1,          // masterchain (workchain = -1)
                    None,        // shard
                    None,        // Block block seqno
                    Some(block), // Masterchain block seqno
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                )
                .await
                .map_err(|e| {
                    ChainCommunicationError::CustomError(format!(
                        "Failed to fetch block info for block {}: {:?}",
                        block, e
                    ))
                })?
                .blocks
                .get(0)
                .ok_or_else(|| {
                    ChainCommunicationError::CustomError(
                        "No blocks found in the response".to_string(),
                    )
                })?
                .gen_utime
                .parse::<i64>()
                .map_err(|e| {
                    ChainCommunicationError::CustomError(format!(
                        "Failed to parse block timestamp: {:?}",
                        e
                    ))
                })
        };

        let start_utime = fetch_block_info(start_block).await?;
        let end_utime = fetch_block_info(end_block).await?;

        let messages = self
            .mailbox
            .provider
            .get_messages(
                None,
                None,
                Some(self.mailbox.mailbox_address.to_string()),
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
                ChainCommunicationError::CustomError(format!(
                    "Failed to fetch messages in range: {:?}",
                    e
                ))
            })?;

        let events = messages
            .messages
            .into_iter()
            .filter_map(|message| {
                parse_message(&message.message_content.body)
                    .ok()
                    .map(|hyperlane_message| {
                        let index_event = Indexed::from(hyperlane_message);
                        let log_meta = LogMeta {
                            address: Default::default(),
                            block_number: 0,
                            block_hash: Default::default(),
                            transaction_id: Default::default(),
                            transaction_index: 0,
                            log_index: Default::default(),
                        };
                        (index_event, log_meta)
                    })
            })
            .collect();

        Ok(events)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let response = self
            .mailbox
            .provider
            .get_blocks(
                -1,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some(1),
                None,
                None,
            )
            .await
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to fetch latest block: {:?}",
                    e
                ))
            })?;

        response
            .blocks
            .first()
            .map(|block| {
                info!("Latest block found: {:?}", block);
                block.seqno as u32
            })
            .ok_or_else(|| {
                warn!("No blocks found in the response: {:?}", response);
                ChainCommunicationError::CustomError("No blocks found".to_string())
            })
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for TonMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(self).await?;
        info!("Tip:{:?}", tip);
        let count = Mailbox::count(&self.mailbox, &ReorgPeriod::None).await?;
        Ok((Some(count), tip))
    }
}

#[async_trait]
impl Indexer<H256> for TonMailboxIndexer {
    async fn fetch_logs_in_range(
        &self,
        _range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        info!(
            "fetch_logs_in_range in TonMailboxIndexer with range:{:?}",
            _range
        );
        todo!()
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        <TonMailboxIndexer as Indexer<HyperlaneMessage>>::get_finalized_block_number(self).await
    }
}
#[async_trait]
impl SequenceAwareIndexer<H256> for TonMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // TODO: implement when ton scraper support is implemented
        info!("Message delivery indexing not implemented");
        let tip = Indexer::<H256>::get_finalized_block_number(self).await?;
        Ok((Some(1), tip))
    }
}

pub(crate) fn build_message(
    opcode: u32,
    message_cell: ArcCell,
    metadata_cell: ArcCell,
    query_id: u64,
    block_number: u64,
) -> Result<Cell, ChainCommunicationError> {
    let mut writer = CellBuilder::new();

    writer.store_u32(32, opcode).map_err(|e| {
        ChainCommunicationError::CustomError(format!("Failed to store process opcode: {}", e))
    })?;

    writer.store_u64(64, query_id).map_err(|e| {
        ChainCommunicationError::CustomError(format!("Failed to store query_id: {}", e))
    })?;

    writer
        .store_u32(32, TonMailbox::PROCESS_INIT)
        .map_err(|e| {
            ChainCommunicationError::CustomError(format!("Failed to store process init: {}", e))
        })?;

    writer.store_u64(48, block_number).map_err(|e| {
        ChainCommunicationError::CustomError(format!("Failed to store block_number: {}", e))
    })?;

    writer.store_reference(&message_cell).map_err(|e| {
        ChainCommunicationError::CustomError(format!("Failed to store message reference: {}", e))
    })?;

    writer.store_reference(&metadata_cell).map_err(|e| {
        ChainCommunicationError::CustomError(format!("Failed to store metadata reference: {}", e))
    })?;

    writer
        .build()
        .map_err(|e| ChainCommunicationError::CustomError(format!("Cell build failed: {}", e)))
}

pub fn parse_message(boc: &str) -> Result<HyperlaneMessage, TonCellError> {
    info!("Boc:{:?}", boc);
    let cell = ConversionUtils::parse_root_cell_from_boc(boc).map_err(|e| {
        error!("Failed to parse root cell from BOC: {:?}", e);
        TonCellError::BagOfCellsDeserializationError(
            "Failed to parse root cell from BOC".to_string(),
        )
    })?;

    let mut parser = cell.parser();

    let id = parser.load_uint(256).map_err(|e| {
        TonCellError::BagOfCellsDeserializationError(format!("Failed to parse ID: {:?}", e))
    })?;
    info!("Parsed message ID: {:x}", id);

    let p = parser.next_reference().map_err(|e| {
        TonCellError::BagOfCellsDeserializationError(format!(
            "Failed to load next reference: {:?}",
            e
        ))
    })?;
    info!("Next reference found: {:?}", p);

    let reference = p.parser().next_reference().map_err(|e| {
        TonCellError::BagOfCellsDeserializationError(format!(
            "Failed to load cell reference: {:?}",
            e
        ))
    })?;

    let mut parser_ref = reference.parser();
    let version = parser_ref.load_u8(8)?;
    let nonce = parser_ref.load_u32(32)?;
    let origin = parser_ref.load_u32(32)?;

    let mut address_bytes = vec![0u8; 32];
    parser_ref.load_slice(&mut address_bytes).map_err(|e| {
        TonCellError::BagOfCellsDeserializationError(format!(
            "Failed to parse sender address: {:?}",
            e
        ))
    })?;

    let sender = H256::from_slice(&address_bytes);
    info!("Parsed sender address: {:x}", sender);

    let destination = parser_ref.load_u32(32)?;
    info!("Parsed destination domain: {}", destination);

    parser_ref.load_slice(&mut address_bytes).map_err(|e| {
        TonCellError::BagOfCellsDeserializationError(format!(
            "Failed to parse recipient address: {:?}",
            e
        ))
    })?;

    let recipient = H256::from_slice(&address_bytes);
    info!("Parsed H256 recipient: {:x}", recipient);

    let body = parser_ref.next_reference().map_err(|e| {
        TonCellError::BagOfCellsDeserializationError(format!(
            "Failed to parse body reference: {:?}",
            e
        ))
    })?;
    let data = body.data();

    let message = HyperlaneMessage {
        version,
        nonce,
        origin,
        sender,
        destination,
        recipient,
        body: data.to_vec(),
    };
    Ok(message)
}
