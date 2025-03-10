use std::ops::RangeInclusive;
use std::{io::Cursor, sync::Arc};

use hex::ToHex;
use hyperlane_cosmos_rs::hyperlane::core::v1::Dispatch;
use prost::Name;
use tendermint::abci::EventAttribute;
use tonic::async_trait;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Decode, HyperlaneMessage, Indexed,
    Indexer, LogMeta, SequenceAwareIndexer, H256, H512,
};

use crate::{
    ConnectionConf, CosmosNativeMailbox, CosmosNativeProvider, HyperlaneCosmosError, Signer,
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
            indexer: EventIndexer::new(Dispatch::full_name(), provider.clone()),
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
        println!("{:#?}", tip);
        let mailbox = self
            .provider
            .grpc()
            .mailbox(self.address.encode_hex(), Some(tip))
            .await?;
        match mailbox.mailbox {
            Some(mailbox) => Ok((Some(mailbox.message_sent), tip)),
            _ => Ok((None, tip)),
        }
    }
}
