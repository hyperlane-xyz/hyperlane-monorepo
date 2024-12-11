use crate::client::provider::TonProvider;
use crate::signer::signer::TonSigner;
use crate::traits::ton_api_center::TonApiCenter;
use crate::ConversionUtils;
use async_trait::async_trait;
use derive_new::new;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    SequenceAwareIndexer, H256, U256,
};
use log::info;
use std::cmp::max;
use std::{
    fmt::{Debug, Formatter},
    ops::RangeInclusive,
    string::ToString,
};
use tonlib_core::TonAddress;
use tracing::warn;

#[derive(Clone)]
pub struct TonInterchainGasPaymaster {
    pub igp_address: TonAddress,
    pub provider: TonProvider,
    pub signer: TonSigner,
    pub workchain: i32,
}
impl TonInterchainGasPaymaster {}

impl HyperlaneContract for TonInterchainGasPaymaster {
    fn address(&self) -> H256 {
        ConversionUtils::ton_address_to_h256(&self.igp_address)
    }
}
impl HyperlaneChain for TonInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.provider.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.provider()
    }
}

impl Debug for TonInterchainGasPaymaster {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TonInterchainGasPaymaster:")
            .field("igp address:", &self.igp_address.to_hex())
            .field("provider", &self.provider)
            .field("wallet:", &self.signer.wallet.address.to_hex())
            .finish()
    }
}
impl InterchainGasPaymaster for TonInterchainGasPaymaster {}

#[derive(Debug, Clone, new)]
pub struct TonInterchainGasPaymasterIndexer {
    provider: TonProvider,
    igp_address: TonAddress,
}

#[async_trait]
impl Indexer<InterchainGasPayment> for TonInterchainGasPaymasterIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        let start_block = max(*range.start(), 1);
        let end_block = max(*range.end(), 1);
        let start_block_info = self
            .provider
            .get_blocks(
                -1,                //  masterchain (workchain = -1)
                None,              // shard
                None,              // block seqno
                Some(start_block), // masterchain seqno
                None,
                None,
                None,
                None,
                None, // limit
                None,
                None,
            )
            .await
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to get start block info: {:?}",
                    e
                ))
            })?;

        info!("Start block info:{:?}", start_block_info);
        let end_block_info = self
            .provider
            .get_blocks(
                -1,              //  masterchain (workchain = -1)
                None,            // shard
                None,            // block seqno
                Some(end_block), // masterchain seqno
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
                    "Failed to get end block info: {:?}",
                    e
                ))
            })?;

        info!("End block info:{:?}", end_block_info);

        let start_utime = start_block_info.blocks[0]
            .gen_utime
            .parse::<i64>()
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to parse start_utime: {:?}",
                    e
                ))
            })?;
        let end_utime = end_block_info.blocks[0]
            .gen_utime
            .parse::<i64>()
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!("Failed to parse end_utime: {:?}", e))
            })?;

        let message_response = self
            .provider
            .get_messages(
                None,
                None,
                Some(self.igp_address.to_string()),
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
            .await;
        match message_response {
            Ok(messages) => {
                info!("Messages:{:?}", messages);

                let mut events = vec![];
                for message in messages.messages {
                    match parse_igp_events(message.message_content.body.as_str()) {
                        Ok(index_event) => {
                            let indexed_data = Indexed::new(index_event);
                            let log_meta = LogMeta {
                                address: Default::default(),
                                block_number: 0,
                                block_hash: Default::default(),
                                transaction_id: Default::default(),
                                transaction_index: 0,
                                log_index: Default::default(),
                            };
                            events.push((indexed_data, log_meta));
                        }
                        Err(e) => {
                            warn!(
                        "Failed to parse interchain gas payment for message: {:?}, error: {:?}",
                        message, e
                    );
                        }
                    }
                }
                Ok(events)
            }
            Err(e) => Err(ChainCommunicationError::CustomError(format!(
                "Failed to fetch messages in range: {:?}",
                e
            ))),
        }
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let response = self
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
                    "Failed to get start block info: {:?}",
                    e
                ))
            })?;

        if let Some(block) = response.blocks.first() {
            Ok(block.seqno as u32)
        } else {
            Err(ChainCommunicationError::CustomError(
                "No blocks found".to_string(),
            ))
        }
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for TonInterchainGasPaymasterIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<InterchainGasPayment>::get_finalized_block_number(self).await?;

        Ok((Some(1), tip))
    }
}

fn parse_igp_events(boc: &str) -> Result<InterchainGasPayment, ChainCommunicationError> {
    let parsed_cell = ConversionUtils::parse_root_cell_from_boc(boc).expect("");

    let mut parser = parsed_cell.parser();

    let message_id = parser.load_uint(256).map_err(|e| {
        ChainCommunicationError::CustomError(format!("Failed to load_uint for message id:{:?}", e))
    })?;
    let message_id = H256::from_slice(message_id.to_bytes_be().as_slice());

    let parser = parser.next_reference().expect("");
    let mut parser = parser.references().first().expect("").parser();
    let dest_domain = parser.load_uint(32).map_err(|e| {
        ChainCommunicationError::CustomError(format!("Failed to load dest_domain: {:?}", e))
    })?;
    let destination = u32::try_from(dest_domain).map_err(|_| {
        ChainCommunicationError::CustomError("Failed to convert dest_domain to u32".to_string())
    })?;

    let gas_limit = parser.load_uint(256).map_err(|e| {
        ChainCommunicationError::CustomError(format!("Failed to load gas_limit: {:?}", e))
    })?;
    let payment = U256::from_big_endian(gas_limit.to_bytes_be().as_slice());

    let required_payment = parser.load_uint(256).map_err(|e| {
        ChainCommunicationError::CustomError(format!("Failed to load required_payment: {:?}", e))
    })?;
    let gas_amount = U256::from_big_endian(required_payment.to_bytes_be().as_slice());

    Ok(InterchainGasPayment {
        message_id,
        destination,
        payment,
        gas_amount,
    })
}
