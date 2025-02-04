use std::ops::RangeInclusive;
use std::{io::Cursor, sync::Arc};

use ::futures::future;
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cosmrs::{tx::Raw, Any, Tx};
use hyperlane_core::MerkleTreeInsertion;
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
    ConnectionConf, CosmosNativeMailbox, CosmosNativeProvider, HyperlaneCosmosError, Signer,
};

use super::{EventIndexer, ParsedEvent};

/// delivery indexer to check if a message was delivered
#[derive(Debug, Clone)]
pub struct CosmosNativeTreeInsertionIndexer {
    indexer: EventIndexer,
    provider: Arc<CosmosNativeProvider>,
    address: H256,
}

impl CosmosNativeTreeInsertionIndexer {
    ///  New Tree Insertion Indexer
    pub fn new(conf: ConnectionConf, locator: ContractLocator) -> ChainResult<Self> {
        let provider =
            CosmosNativeProvider::new(locator.domain.clone(), conf, locator.clone(), None)?;
        let provider = Arc::new(provider);
        Ok(CosmosNativeTreeInsertionIndexer {
            indexer: EventIndexer::new(
                "hyperlane.core.v1.InsertedIntoTree".to_string(),
                provider.clone(),
            ),
            provider,
            address: locator.address,
        })
    }

    #[instrument(err)]
    fn tree_insertion_parser(
        attrs: &Vec<EventAttribute>,
    ) -> ChainResult<ParsedEvent<MerkleTreeInsertion>> {
        let mut message_id: Option<H256> = None;
        let mut leaf_index: Option<u32> = None;
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
                "mailbox_id" => {
                    contract_address = Some(value.parse()?);
                }
                "index" => leaf_index = Some(value.parse()?),
                _ => continue,
            }
        }

        let contract_address = contract_address
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing contract_address"))?;
        let message_id = message_id
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing message_id"))?;
        let leaf_index = leaf_index
            .ok_or_else(|| ChainCommunicationError::from_other_str("missing leafindex"))?;
        let insertion = MerkleTreeInsertion::new(leaf_index, message_id);

        Ok(ParsedEvent::new(contract_address, insertion))
    }
}

#[async_trait]
impl Indexer<MerkleTreeInsertion> for CosmosNativeTreeInsertionIndexer {
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        self.indexer
            .fetch_logs_in_range(range, Self::tree_insertion_parser)
            .await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.get_finalized_block_number().await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        self.indexer
            .fetch_logs_by_tx_hash(tx_hash, Self::tree_insertion_parser)
            .await
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for CosmosNativeTreeInsertionIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<MerkleTreeInsertion>::get_finalized_block_number(&self).await?;
        let sequence = self
            .provider
            .rest()
            .leaf_count_at_height(self.address, tip)
            .await?;
        Ok((Some(sequence), tip))
    }
}
