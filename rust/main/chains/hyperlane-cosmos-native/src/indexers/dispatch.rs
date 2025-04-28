use std::io::Cursor;
use std::ops::RangeInclusive;

use hex::ToHex;
use hyperlane_cosmos_rs::hyperlane::core::v1::EventDispatch;
use hyperlane_cosmos_rs::prost::Name;
use tendermint::abci::EventAttribute;
use tonic::async_trait;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Decode, HyperlaneMessage, Indexed,
    Indexer, LogMeta, SequenceAwareIndexer, H256, H512,
};

use crate::{CosmosNativeProvider, HyperlaneCosmosError, RpcProvider};

use super::{CosmosEventIndexer, ParsedEvent};

/// Dispatch indexer to check if a new hyperlane message was dispatched
#[derive(Debug, Clone)]
pub struct CosmosNativeDispatchIndexer {
    provider: CosmosNativeProvider,
    address: H256,
}

impl CosmosNativeDispatchIndexer {
    ///  New Dispatch Indexer
    pub fn new(provider: CosmosNativeProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(CosmosNativeDispatchIndexer {
            provider,
            address: locator.address,
        })
    }
}

impl CosmosEventIndexer<HyperlaneMessage> for CosmosNativeDispatchIndexer {
    fn target_type() -> String {
        EventDispatch::full_name()
    }

    fn provider(&self) -> &RpcProvider {
        self.provider.rpc()
    }

    #[instrument(err)]
    fn parse(&self, attrs: &[EventAttribute]) -> ChainResult<ParsedEvent<HyperlaneMessage>> {
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

    fn address(&self) -> &H256 {
        &self.address
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
        CosmosEventIndexer::fetch_logs_in_range(self, range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        CosmosEventIndexer::get_finalized_block_number(self).await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        CosmosEventIndexer::fetch_logs_by_tx_hash(self, tx_hash).await
    }
}

#[async_trait]
impl SequenceAwareIndexer<HyperlaneMessage> for CosmosNativeDispatchIndexer {
    #[instrument(err, skip(self), ret)]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = CosmosEventIndexer::get_finalized_block_number(self).await?;
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
