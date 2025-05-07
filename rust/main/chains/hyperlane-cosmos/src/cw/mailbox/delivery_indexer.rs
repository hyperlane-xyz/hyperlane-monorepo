use std::borrow::ToOwned;
use std::fmt::Debug;
use std::ops::RangeInclusive;
use std::str::FromStr;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use once_cell::sync::Lazy;
use tendermint::abci::EventAttribute;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Delivery, Indexed, Indexer, LogMeta,
    SequenceAwareIndexer, H256, H512,
};

use crate::cw::CwQueryClient;
use crate::indexer::{CosmosEventIndexer, ParsedEvent};
use crate::utils::{CONTRACT_ADDRESS_ATTRIBUTE_KEY, CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64};
use crate::{CosmosAddress, CosmosProvider, HyperlaneCosmosError, RpcProvider};

/// The message process event type from the CW contract.
pub const MESSAGE_DELIVERY_EVENT_TYPE: &str = "wasm-mailbox_process_id";
const MESSAGE_ID_ATTRIBUTE_KEY: &str = "message_id";
static MESSAGE_ID_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(MESSAGE_ID_ATTRIBUTE_KEY));

/// Struct that retrieves delivery event data for a Cosmos Mailbox contract
#[derive(Debug, Clone)]
pub struct CwMailboxDeliveryIndexer {
    provider: CosmosProvider<CwQueryClient>,
    address: H256,
}

impl CwMailboxDeliveryIndexer {
    /// Create a reference to a mailbox at a specific Cosmos address on some
    /// chain
    pub fn new(provider: CosmosProvider<CwQueryClient>, locator: &ContractLocator) -> Self {
        Self {
            provider,
            address: locator.address,
        }
    }

    #[instrument(err)]
    fn hyperlane_delivery_parser(attrs: &[EventAttribute]) -> ChainResult<ParsedEvent<Delivery>> {
        let mut contract_address: Option<String> = None;
        let mut message_id: Option<Delivery> = None;

        for attr in attrs {
            match attr {
                EventAttribute::V037(a) => {
                    let key = a.key.as_str();
                    let value = a.value.as_str();

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
                            message_id = Some(value.parse::<H256>()?);
                        }
                        v if *MESSAGE_ID_ATTRIBUTE_KEY_BASE64 == v => {
                            let hex = String::from_utf8(
                                BASE64
                                    .decode(value)
                                    .map_err(Into::<HyperlaneCosmosError>::into)?,
                            )?;
                            message_id = Some(hex.parse::<H256>()?);
                        }

                        _ => {}
                    }
                }

                EventAttribute::V034(_a) => {
                    unimplemented!();
                }
            }
        }

        let contract_address = contract_address
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing contract_address"))?;
        let message_id = message_id
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing message_id"))?;

        Ok(ParsedEvent::new(
            CosmosAddress::from_str(&contract_address)?.digest(),
            message_id,
        ))
    }
}

impl CosmosEventIndexer<H256> for CwMailboxDeliveryIndexer {
    fn target_type() -> String {
        MESSAGE_DELIVERY_EVENT_TYPE.to_owned()
    }

    fn provider(&self) -> &RpcProvider {
        self.provider.rpc()
    }

    fn parse(&self, attrs: &[EventAttribute]) -> ChainResult<ParsedEvent<H256>> {
        Self::hyperlane_delivery_parser(attrs)
    }

    fn address(&self) -> &H256 {
        &self.address
    }
}

#[async_trait]
impl Indexer<H256> for CwMailboxDeliveryIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        CosmosEventIndexer::fetch_logs_in_range(self, range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        CosmosEventIndexer::get_finalized_block_number(self).await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        CosmosEventIndexer::fetch_logs_by_tx_hash(self, tx_hash).await
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for CwMailboxDeliveryIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<H256>::get_finalized_block_number(&self).await?;

        // No sequence for message deliveries.
        Ok((None, tip))
    }
}
