use std::{
    fmt::{Debug, Formatter},
    ops::RangeInclusive,
    sync::Arc,
    time::SystemTime,
};

use async_trait::async_trait;
use base64::{engine::general_purpose, Engine};
use num_bigint::BigUint;
use tonlib_core::{
    cell::{ArcCell, BagOfCells, Cell, CellBuilder, StateInit, TonCellError},
    message::{CommonMsgInfo, InternalMessage, TonMessage, TransferMessage},
    TonAddress,
};
use tracing::{error, info, instrument, warn};

use hyperlane_core::{
    ChainCommunicationError, ChainResult, FixedPointNumber, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, LogMeta, Mailbox,
    ReorgPeriod, SequenceAwareIndexer, TxCostEstimate, TxOutcome, H256, U256,
};

use crate::{
    client::provider::TonProvider,
    constants::LIMIT,
    error::HyperlaneTonError,
    message::Message,
    signer::signer::TonSigner,
    traits::ton_api_center::TonApiCenter,
    utils::{
        conversion::ConversionUtils, log_meta::create_ton_log_meta, pagination::paginate_logs,
    },
};

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

    async fn get_delivery_code(&self) -> ChainResult<ArcCell> {
        let mailbox_hex = self.mailbox_address.to_hex();
        let err_mapper =
            |e| ChainCommunicationError::from_other(HyperlaneTonError::TonCellError(e));
        let response = self
            .provider
            .run_get_method(&mailbox_hex, "get_storage", None)
            .await
            .map_err(|e| {
                info!("delivered error:{:?}", e);
                ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                    "Error calling run_get_method: {:?}",
                    e
                )))
            })?;

        let stack_item = response.stack.first().ok_or_else(|| {
            ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(
                "No stack item found in response".to_string(),
            ))
        })?;

        stack_item
            .as_cell()?
            .parser()
            .next_reference()
            .map_err(err_mapper)
    }

    fn get_delivery_data(&self, message_id: &H256) -> ChainResult<ArcCell> {
        let err_mapper =
            |e| ChainCommunicationError::from_other(HyperlaneTonError::TonCellError(e));
        Ok(Arc::new(
            CellBuilder::new()
                .store_bit(false)
                .map_err(err_mapper)?
                .store_slice(&message_id.as_bytes())
                .map_err(err_mapper)?
                .store_address(&self.mailbox_address)
                .map_err(err_mapper)?
                .build()
                .map_err(err_mapper)?,
        ))
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
        Box::new(self.provider.clone())
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
    const PROCESS_OPCODE: u32 = 0x658A3AF3;
}
#[async_trait]
impl Mailbox for TonMailbox {
    async fn count(&self, _reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let mailbox_str = self.mailbox_address.to_string();
        let response = self
            .provider
            .run_get_method(&mailbox_str, "get_nonce", Some(vec![]))
            .await
            .map_err(|e| {
                HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to run get_nonce method: {:?}",
                    e
                ))
            })?;

        ConversionUtils::parse_stack_item_to_u32(&response.stack, 0).map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::FailedToParseStackItem(format!(
                "Failed to parse stack item to u32: {:?}",
                e
            )))
        })
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let state_hash = StateInit::create_account_id(
            &self.get_delivery_code().await?,
            &self.get_delivery_data(&id)?,
        )
        .map_err(|e| ChainCommunicationError::from_other(HyperlaneTonError::TonCellError(e)))?;
        let delivery_address = TonAddress::new(0, &state_hash);
        let accounts = self
            .provider
            .get_account_state(delivery_address.to_string(), false)
            .await?
            .accounts;
        let delivered = accounts
            .get(0)
            .and_then(|x| x.status.as_ref())
            .map(|x| x == "active")
            .unwrap_or(false);
        info!("delivered {:?} for Id:{:?}", delivered, id);
        Ok(delivered)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        let mailbox_hex = self.mailbox_address.to_hex();
        let response = self
            .provider
            .run_get_method(&mailbox_hex, "get_default_ism", None)
            .await
            .map_err(|e| {
                HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to get default ISM response: {:?}",
                    e
                ))
            })?;

        let stack = response.stack.first().ok_or_else(|| {
            ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(
                "No data in stack".to_string(),
            ))
        })?;

        let ism_address = stack.as_cell()?.parser().load_address().map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Failed to parse address from BOC: {:?}",
                e
            )))
        })?;

        Ok(ConversionUtils::ton_address_to_h256(&ism_address))
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        let recipient_address = ConversionUtils::h256_to_ton_address(&recipient, self.workchain);
        let recipient_hex = recipient_address.to_hex();
        let recipient_response = self
            .provider
            .run_get_method(&recipient_hex, "get_ism", None)
            .await;

        let response = match recipient_response {
            Ok(response) => response,
            Err(_) => return self.default_ism().await,
        };

        let stack = response.stack.first().ok_or_else(|| {
            ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(
                "No data found in the response stack".to_string(),
            ))
        })?;

        if stack.r#type != "cell" {
            return Err(ChainCommunicationError::from(
                HyperlaneTonError::ParsingError(format!(
                    "Unexpected data type in stack: expected 'cell', got '{}'",
                    stack.r#type
                )),
            ));
        }
        let boc = ConversionUtils::extract_boc_from_stack_item(stack)?;

        let recipient_ism = ConversionUtils::parse_address_from_boc(boc).map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Failed to parse address from BOC: {:?}",
                e
            )))
        })?;
        if recipient_ism.to_base64_url() == "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c" {
            info!("recipient_ism is zero, execute default_ism");
            return self.default_ism().await;
        }

        Ok(ConversionUtils::ton_address_to_h256(&recipient_ism))
    }

    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        info!("HyperlaneMessage in process:{:?}", message);
        info!("metadata in process:{:?}", metadata);
        let message_cell = ConversionUtils::build_hyperlane_message_cell(message).map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::FailedBuildingCell(format!(
                "Failed to build HyperlaneMessage to Ton Cell: {:?}",
                e
            )))
        })?;

        let metadata_cell = ConversionUtils::metadata_to_cell(metadata).map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::FailedBuildingCell(format!(
                "Failed to build metadata to Ton Cell: {:?}",
                e
            )))
        })?;

        let query_id = 1; // it is not currently used in the contract

        let msg = build_message(
            TonMailbox::PROCESS_OPCODE,
            ArcCell::new(message_cell),
            ArcCell::new(metadata_cell),
            query_id,
        )
        .map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::FailedBuildingCell(format!(
                "Failed to build message: {:?}",
                e
            )))
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
            ChainCommunicationError::from(HyperlaneTonError::FailedBuildingCell(format!(
                "Failed to create transfer message in process: {:?}",
                e
            )))
        })?;

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(format!(
                    "Failed to get current time: {:?}",
                    e
                )))
            })?
            .as_secs() as u32;

        let seqno = self
            .provider
            .get_wallet_information(self.signer.address.to_hex().as_str(), true)
            .await
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to get wallet state: {:?}",
                    e
                )))
            })?
            .seqno;

        let message = self
            .signer
            .wallet
            .create_external_message(
                now + 60,
                seqno as u32,
                vec![ArcCell::new(transfer_message.clone())],
                false,
            )
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::FailedBuildingCell(format!(
                    "Failed to create external message: {:?}",
                    e
                )))
            })?;

        let boc = BagOfCells::from_root(message.clone())
            .serialize(true)
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                    "Failed to serialize BOC: {:?}",
                    e
                )))
            })?;

        let boc_str = general_purpose::STANDARD.encode(&boc);
        info!("create_external_message:{:?}", boc_str);

        let tx = self.provider.send_message(boc_str).await.map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                "Failed to send message in provider: {:?}",
                e
            )))
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
        let (start_utime, end_utime) = self.mailbox.provider.get_utime_range(range).await?;
        info!(
            "fetch_logs_in_range in TonMailboxIndexer with start_utime:{:?} end_utime:{:?}",
            start_utime, end_utime
        );

        let mailbox_addr = self.mailbox.mailbox_address.to_string();
        let mailbox_addr_h256 = ConversionUtils::ton_address_to_h256(&self.mailbox.mailbox_address);

        let parse_fn = |message: Message| {
            parse_message(&message.message_content.body)
                .ok()
                .map(|hyperlane_message| {
                    (
                        Indexed::from(hyperlane_message),
                        create_ton_log_meta(mailbox_addr_h256),
                    )
                })
        };
        paginate_logs(
            &self.mailbox.provider,
            &mailbox_addr,
            start_utime,
            end_utime,
            LIMIT as u32,
            0,
            parse_fn,
        )
        .await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.mailbox
            .provider
            .get_finalized_block()
            .await
            .map_err(|e| {
                HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to fetch finalized block number for TonMailboxIndexer: {:?}",
                    e
                ))
                .into()
            })
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for TonMailboxIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(self).await?;

        let count = Mailbox::count(&self.mailbox, &ReorgPeriod::None).await?;
        Ok((Some(count), tip))
    }
}

#[async_trait]
impl Indexer<H256> for TonMailboxIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        let (start_utime, end_utime) = self.mailbox.provider.get_utime_range(range).await?;

        let mailbox_addr = self.mailbox.mailbox_address.to_string();
        let mailbox_addr_h256 = ConversionUtils::ton_address_to_h256(&self.mailbox.mailbox_address);

        let parse_fn = move |message: Message| {
            let decoded = match general_purpose::STANDARD.decode(&message.hash) {
                Ok(d) => d,
                Err(_) => {
                    warn!("Failed to decode hash: {}", message.hash);
                    return None;
                }
            };
            if decoded.len() != 32 {
                warn!("Decoded hash has invalid length: {}", decoded.len());
                return None;
            };
            let index_event = Indexed::new(H256::from_slice(&decoded));
            let log_meta = create_ton_log_meta(mailbox_addr_h256);
            Some((index_event, log_meta))
        };

        paginate_logs(
            &self.mailbox.provider,
            &mailbox_addr,
            start_utime,
            end_utime,
            LIMIT as u32,
            0,
            parse_fn,
        )
        .await
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
        Ok((None, tip))
    }
}

pub(crate) fn build_message(
    opcode: u32,
    message_cell: ArcCell,
    metadata_cell: ArcCell,
    query_id: u64,
) -> Result<Cell, ChainCommunicationError> {
    CellBuilder::new()
        .store_u32(32, opcode)
        .and_then(|b| b.store_u64(64, query_id))
        .and_then(|b| b.store_reference(&message_cell))
        .and_then(|b| b.store_reference(&metadata_cell))
        .and_then(|b| b.build())
        .map_err(|e| ChainCommunicationError::from_other(HyperlaneTonError::TonCellError(e)))
}

pub fn parse_message(boc: &str) -> Result<HyperlaneMessage, TonCellError> {
    let cell = ConversionUtils::parse_root_cell_from_boc(boc).map_err(|e| {
        error!("Failed to parse root cell from BOC: {:?}", e);
        TonCellError::BagOfCellsDeserializationError(
            "Failed to parse root cell from BOC".to_string(),
        )
    })?;

    let mut parser = cell.parser();

    let _id = parser.load_uint(256).map_err(|e| {
        TonCellError::BagOfCellsDeserializationError(format!("Failed to parse ID: {:?}", e))
    })?;

    let p = parser.next_reference().map_err(|e| {
        TonCellError::BagOfCellsDeserializationError(format!(
            "Failed to load next reference: {:?}",
            e
        ))
    })?;

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

    let destination = parser_ref.load_u32(32)?;

    parser_ref.load_slice(&mut address_bytes).map_err(|e| {
        TonCellError::BagOfCellsDeserializationError(format!(
            "Failed to parse recipient address: {:?}",
            e
        ))
    })?;

    let recipient = H256::from_slice(&address_bytes);

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
    info!("HyperlaneMessage in parse_message:{}", message);
    Ok(message)
}

#[cfg(test)]
mod tests {
    use crate::TonConnectionConf;

    use super::*;
    use reqwest::{Client, Url};
    use std::env;
    use std::ops::RangeInclusive;
    use std::str::FromStr;
    use tokio;

    fn create_indexer() -> TonMailboxIndexer {
        let mailbox_address =
            env::var("TEST_ADDRESS").expect("TEST_ADDRESS env variable must be set");
        let mailbox_address =
            TonAddress::from_base64_url(&mailbox_address).expect("Failed to create address");
        let api_key = env::var("API_KEY").expect("API_KEY env variable must be set");
        let mnemonic_phrase =
            env::var("MNEMONIC_PHRASE").expect("MNEMONIC_PHRASE env variable must be set");

        let mnemonic_words: Vec<String> = mnemonic_phrase
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();

        let signer =
            TonSigner::from_mnemonic(mnemonic_words, tonlib_core::wallet::WalletVersion::V4R2)
                .expect("Failed to create signer");

        let client = Client::new();

        let url = Url::from_str("https://testnet.toncenter.com/api/")
            .expect("Failed to create url from str");

        let config = TonConnectionConf::new(url, api_key, 10);

        let provider = TonProvider::new(
            client,
            config,
            HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::TonTest1),
        );
        let mailbox = TonMailbox {
            provider,
            mailbox_address: mailbox_address.clone(),
            signer,
            workchain: 0,
        };

        let indexer = TonMailboxIndexer { mailbox };
        indexer
    }

    #[tokio::test]
    #[ignore]
    async fn test_fetch_logs_in_range() {
        let indexer = create_indexer();
        let block_range: RangeInclusive<u32> = 1..=28039020;

        let result: Result<Vec<(Indexed<HyperlaneMessage>, LogMeta)>, ChainCommunicationError> =
            indexer.fetch_logs_in_range(block_range).await;

        match result {
            Ok(events) => {
                println!("Fetched {} events", events.len());
                println!("Event random:{:?}", events.first());
                assert!(
                    !events.is_empty(),
                    "Expected some events to be fetched from the mailbox"
                );
            }
            Err(err) => {
                panic!("fetch_logs_in_range failed: {:?}", err);
            }
        }
    }

    #[tokio::test]
    #[ignore]
    async fn test_fetch_logs_in_range_empty() {
        let indexer = create_indexer();
        let block_range: RangeInclusive<u32> = 1..=2;

        let result: Result<Vec<(Indexed<H256>, LogMeta)>, ChainCommunicationError> =
            indexer.fetch_logs_in_range(block_range).await;

        match result {
            Ok(events) => {
                println!("Fetched {} events", events.len());
                assert!(
                    events.is_empty(),
                    "Expected no events in the mailbox, but got some"
                );
            }
            Err(err) => {
                panic!("fetch_logs_in_range failed: {:?}", err);
            }
        }
    }
}
