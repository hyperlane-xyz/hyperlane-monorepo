use std::ops::RangeInclusive;

use hyperlane_cosmos_rs::{hyperlane::core::v1::EventProcess, prost::Name};
use tendermint::abci::EventAttribute;
use tonic::async_trait;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Indexed, Indexer, LogMeta,
    SequenceAwareIndexer, H256, H512,
};

use crate::{
    native::module_query_client::ModuleQueryClient, CosmosProvider, HyperlaneCosmosError,
    RpcProvider,
};

use crate::indexer::{CosmosEventIndexer, ParsedEvent};

/// Delivery indexer to check if a message was delivered
#[derive(Debug, Clone)]
pub struct CosmosNativeDeliveryIndexer {
    provider: CosmosProvider<ModuleQueryClient>,
    address: H256,
}

impl CosmosNativeDeliveryIndexer {
    ///  New Delivery Indexer
    pub fn new(
        provider: CosmosProvider<ModuleQueryClient>,
        locator: ContractLocator,
    ) -> ChainResult<Self> {
        Ok(CosmosNativeDeliveryIndexer {
            provider,
            address: locator.address,
        })
    }
}

impl CosmosEventIndexer<H256> for CosmosNativeDeliveryIndexer {
    fn target_type() -> String {
        EventProcess::full_name()
    }

    fn provider(&self) -> &RpcProvider {
        self.provider.rpc()
    }

    #[instrument(err)]
    fn parse(&self, attrs: &[EventAttribute]) -> ChainResult<ParsedEvent<H256>> {
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

    fn address(&self) -> &H256 {
        &self.address
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
impl SequenceAwareIndexer<H256> for CosmosNativeDeliveryIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = CosmosEventIndexer::get_finalized_block_number(self).await?;
        Ok((None, tip))
    }
}
