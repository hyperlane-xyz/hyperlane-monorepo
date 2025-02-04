use std::ops::RangeInclusive;
use std::{io::Cursor, sync::Arc};

use ::futures::future;
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cosmrs::{tx::Raw, Any, Tx};
use hyperlane_core::ReorgPeriod;
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

/// Dispatch indexer to check if a new hyperlane message was dispatched
#[derive(Debug, Clone)]
pub struct CosmosNativeDispatchIndexer {
    indexer: EventIndexer,
    provider: Arc<CosmosNativeProvider>,
    address: H256,
}

impl CosmosNativeDispatchIndexer {
    ///  New Dispatch Indexer
    pub fn new(conf: ConnectionConf, locator: ContractLocator) -> ChainResult<Self> {
        let provider =
            CosmosNativeProvider::new(locator.domain.clone(), conf, locator.clone(), None)?;
        let provider = Arc::new(provider);

        Ok(CosmosNativeDispatchIndexer {
            indexer: EventIndexer::new("hyperlane.core.v1.Dispatch".to_string(), provider.clone()),
            provider,
            address: locator.address,
        })
    }

    #[instrument(err)]
    fn dispatch_parser(attrs: &Vec<EventAttribute>) -> ChainResult<ParsedEvent<HyperlaneMessage>> {
        let mut message: Option<HyperlaneMessage> = None;
        let mut contract_address: Option<H256> = None;

        for attribute in attrs {
            let key = attribute.key_str().map_err(HyperlaneCosmosError::from)?;
            let value = attribute
                .value_str()
                .map_err(HyperlaneCosmosError::from)?
                .replace("\"", "");
            match key {
                "message" => {
                    let value = value.strip_prefix("0x").unwrap_or(&value);
                    let mut reader = Cursor::new(hex::decode(value)?);
                    message = Some(HyperlaneMessage::read_from(&mut reader)?);
                }
                "origin_mailbox_id" => {
                    contract_address = Some(value.parse()?);
                }
                _ => {}
            }
        }

        let contract_address = contract_address
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing contract_address"))?;
        let message =
            message.ok_or_else(|| ChainCommunicationError::from_other_str("missing message"))?;

        Ok(ParsedEvent::new(contract_address, message))
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for CosmosNativeDispatchIndexer {
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        self.indexer
            .fetch_logs_in_range(range, Self::dispatch_parser)
            .await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        self.indexer
            .fetch_logs_by_tx_hash(tx_hash, Self::dispatch_parser)
            .await
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for CosmosNativeDispatchIndexer {
    #[instrument(err, skip(self), ret)]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        let sequence = self
            .provider
            .rest()
            .leaf_count_at_height(self.address, tip)
            .await?;
        Ok((Some(sequence), tip))
    }
}
