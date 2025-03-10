use std::{
    fmt::{Debug, Formatter},
    ops::RangeInclusive,
    string::ToString,
};

use async_trait::async_trait;
use derive_new::new;
use tonlib_core::TonAddress;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    SequenceAwareIndexer, H256, U256,
};

use crate::{
    client::provider::TonProvider,
    constants::LIMIT,
    error::HyperlaneTonError,
    message::Message,
    signer::signer::TonSigner,
    utils::{log_meta::create_ton_log_meta, pagination::paginate_logs},
    ConversionUtils,
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
        let (start_utime, end_utime) = self.provider.get_utime_range(range).await?;

        let igp_address = self.igp_address.to_string();
        let igp_address_h256 = ConversionUtils::ton_address_to_h256(&self.igp_address);

        let parse_fn = |message: Message| {
            parse_igp_events(&message.message_content.body)
                .ok()
                .map(|hyperlane_message| {
                    (
                        Indexed::from(hyperlane_message),
                        create_ton_log_meta(igp_address_h256),
                    )
                })
        };

        paginate_logs(
            &self.provider,
            &igp_address,
            start_utime,
            end_utime,
            LIMIT as u32,
            0,
            parse_fn,
        )
        .await
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
