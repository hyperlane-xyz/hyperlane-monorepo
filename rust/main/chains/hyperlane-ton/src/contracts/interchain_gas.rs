use std::{
    cmp::max,
    fmt::{Debug, Formatter},
    ops::RangeInclusive,
    string::ToString,
};

use async_trait::async_trait;
use derive_new::new;
use tonlib_core::TonAddress;
use tracing::{info, warn};

use hyperlane_core::{
    ChainCommunicationError, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    SequenceAwareIndexer, H256, H512, U256,
};

use crate::{
    client::provider::TonProvider, error::HyperlaneTonError, signer::signer::TonSigner,
    traits::ton_api_center::TonApiCenter, ConversionUtils,
};

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
        info!("fetch_logs_in_range in GasPaymster start");
        let start_block = max(*range.start(), 1);
        let end_block = max(*range.end(), 1);

        let timestamps = self
            .provider
            .fetch_blocks_timestamps(vec![start_block, end_block])
            .await?;

        let start_utime = *timestamps.get(0).ok_or_else(|| {
            HyperlaneTonError::ParsingError("Failed to get start_utime".to_string())
        })?;
        let end_utime = *timestamps.get(1).ok_or_else(|| {
            HyperlaneTonError::ParsingError("Failed to get end_utime".to_string())
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
            .await
            .map_err(|e| {
                HyperlaneTonError::ApiRequestFailed(format!("Failed to fetch messages: {:?}", e))
            })?;

        let events = message_response
            .messages
            .iter()
            .filter_map(
                |message| match parse_igp_events(&message.message_content.body) {
                    Ok(event) => Some((
                        Indexed::new(event),
                        LogMeta {
                            address: ConversionUtils::ton_address_to_h256(&self.igp_address),
                            block_number: 0,
                            block_hash: H256::zero(),
                            transaction_id: H512::zero(),
                            transaction_index: 0,
                            log_index: U256::zero(),
                        },
                    )),
                    Err(e) => {
                        warn!(
                            "Failed to parse interchain gas payment for message: {:?}, error: {:?}",
                            message, e
                        );
                        None
                    }
                },
            )
            .collect();

        Ok(events)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.provider.get_finalized_block().await.map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(format!(
                "Failed to fetch finalized block number: {:?}",
                e
            )))
        })
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
    let parsed_cell = ConversionUtils::parse_root_cell_from_boc(boc)
        .map_err(|e| HyperlaneTonError::ParsingError(format!("Failed to parse BOC: {:?}", e)))?;

    let mut parser = parsed_cell.parser();

    let message_id = parser.load_uint(256).map_err(|e| {
        HyperlaneTonError::ParsingError(format!("Failed to load_uint for message id: {:?}", e))
    })?;
    let message_id = H256::from_slice(message_id.to_bytes_be().as_slice());

    let reference = parser.next_reference().map_err(|e| {
        HyperlaneTonError::ParsingError(format!("Failed to load next reference: {:?}", e))
    })?;

    let mut parser = reference.parser();
    let dest_domain = parser.load_uint(32).map_err(|e| {
        HyperlaneTonError::ParsingError(format!("Failed to load dest_domain: {:?}", e))
    })?;

    let destination = u32::try_from(dest_domain).map_err(|_| {
        HyperlaneTonError::ParsingError("Failed to convert dest_domain to u32".to_string())
    })?;

    let gas_limit = parser.load_uint(256).map_err(|e| {
        HyperlaneTonError::ParsingError(format!("Failed to load gas_limit: {:?}", e))
    })?;

    let payment = U256::from_big_endian(gas_limit.to_bytes_be().as_slice());

    let required_payment = parser.load_uint(256).map_err(|e| {
        HyperlaneTonError::ParsingError(format!("Failed to load required_payment: {:?}", e))
    })?;

    let gas_amount = U256::from_big_endian(required_payment.to_bytes_be().as_slice());

    Ok(InterchainGasPayment {
        message_id,
        destination,
        payment,
        gas_amount,
    })
}
