use std::ops::RangeInclusive;
use std::{io::Cursor, sync::Arc};

use ::futures::future;
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cosmrs::{tx::Raw, Any, Tx};
use once_cell::sync::Lazy;
use prost::Message;
use tendermint::abci::EventAttribute;
use tokio::{sync::futures, task::JoinHandle};
use tracing::{instrument, warn};

use hyperlane_core::{
    rpc_clients::BlockNumberGetter, utils, ChainCommunicationError, ChainResult, ContractLocator,
    Decode, HyperlaneContract, HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, LogMeta,
    SequenceAwareIndexer, H256, H512,
};

use crate::{
    ConnectionConf, CosmosNativeMailbox, CosmosNativeProvider, HyperlaneCosmosError,
    MsgProcessMessage, Signer,
};

use super::{EventIndexer, ParsedEvent};

/// delivery indexer to check if a message was delivered
#[derive(Debug, Clone)]
pub struct CosmosNativeDeliveryIndexer {
    indexer: EventIndexer,
}

impl CosmosNativeDeliveryIndexer {
    ///  New Delivery Indexer
    pub fn new(conf: ConnectionConf, locator: ContractLocator) -> ChainResult<Self> {
        let provider = CosmosNativeProvider::new(locator.domain.clone(), conf, locator, None)?;
        Ok(CosmosNativeDeliveryIndexer {
            indexer: EventIndexer::new("hyperlane.core.v1.Process".to_string(), Arc::new(provider)),
        })
    }

    #[instrument(err)]
    fn delivery_parser(attrs: &Vec<EventAttribute>) -> ChainResult<ParsedEvent<H256>> {
        let mut message_id: Option<H256> = None;
        let mut contract_address: Option<H256> = None;

        for attribute in attrs {
            let key = attribute.key_str().map_err(HyperlaneCosmosError::from)?;
            let value = attribute
                .value_str()
                .map_err(HyperlaneCosmosError::from)?
                .replace("\"", "");
            match key {
                "message_id" => {
                    message_id = Some(value.parse()?);
                }
                "origin_mailbox_id" => {
                    contract_address = Some(value.parse()?);
                }
                _ => continue,
            }
        }

        let contract_address = contract_address
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing contract_address"))?;
        let message_id = message_id
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing message_id"))?;

        Ok(ParsedEvent::new(contract_address, message_id))
    }
}

#[async_trait]
impl Indexer<H256> for CosmosNativeDeliveryIndexer {
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        self.indexer
            .fetch_logs_in_range(range, Self::delivery_parser)
            .await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        self.indexer
            .fetch_logs_by_tx_hash(tx_hash, Self::delivery_parser)
            .await
    }
}

#[async_trait]
impl SequenceAwareIndexer<H256> for CosmosNativeDeliveryIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}
