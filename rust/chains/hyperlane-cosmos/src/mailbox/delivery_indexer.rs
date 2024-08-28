use std::borrow::ToOwned;
use std::fmt::{Debug, Formatter};
use std::ops::RangeInclusive;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use once_cell::sync::Lazy;
use tendermint::abci::EventAttribute;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Delivery, Indexed, Indexer, LogMeta,
    SequenceAwareIndexer, H256,
};

use crate::rpc::{CosmosWasmIndexer, ParsedEvent, WasmIndexer};
use crate::utils::{
    execute_and_parse_log_futures, CONTRACT_ADDRESS_ATTRIBUTE_KEY,
    CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64,
};
use crate::{ConnectionConf, HyperlaneCosmosError, Signer};

/// The message process event type from the CW contract.
const MESSAGE_DELIVERY_EVENT_TYPE: &str = "mailbox_process_id";
const MESSAGE_ID_ATTRIBUTE_KEY: &str = "message_id";
static MESSAGE_ID_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(MESSAGE_ID_ATTRIBUTE_KEY));

/// Struct that retrieves delivery event data for a Cosmos Mailbox contract
pub struct CosmosMailboxDeliveryIndexer {
    indexer: Box<CosmosWasmIndexer>,
}

impl CosmosMailboxDeliveryIndexer {
    /// Create a reference to a mailbox at a specific Cosmos address on some
    /// chain
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
        reorg_period: u32,
    ) -> ChainResult<Self> {
        let indexer = CosmosWasmIndexer::new(
            conf,
            locator,
            MESSAGE_DELIVERY_EVENT_TYPE.to_owned(),
            reorg_period,
        )?;

        Ok(Self {
            indexer: Box::new(indexer),
        })
    }

    #[instrument(err)]
    fn hyperlane_delivery_parser(
        attrs: &Vec<EventAttribute>,
    ) -> ChainResult<ParsedEvent<Delivery>> {
        let mut contract_address: Option<String> = None;
        let mut message_id: Option<Delivery> = None;

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

        let contract_address = contract_address
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing contract_address"))?;
        let message_id = message_id
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing message_id"))?;

        Ok(ParsedEvent::new(contract_address, message_id))
    }
}

impl Debug for CosmosMailboxDeliveryIndexer {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        todo!()
    }
}

#[async_trait]
impl Indexer<H256> for CosmosMailboxDeliveryIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        let logs_futures: Vec<_> = range
            .map(|block_number| {
                let indexer = self.indexer.clone();
                tokio::spawn(async move {
                    let logs = indexer
                        .get_logs_in_block(
                            block_number,
                            Self::hyperlane_delivery_parser,
                            "DeliveryCursor",
                        )
                        .await;
                    (logs, block_number)
                })
            })
            .collect();

        execute_and_parse_log_futures(logs_futures).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for CosmosMailboxDeliveryIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<H256>::get_finalized_block_number(&self).await?;

        // No sequence for message deliveries.
        Ok((None, tip))
    }
}
