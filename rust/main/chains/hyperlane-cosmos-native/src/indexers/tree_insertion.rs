use std::ops::RangeInclusive;
use std::sync::Arc;

use hex::ToHex;
use hyperlane_cosmos_rs::{hyperlane::core::post_dispatch::v1::InsertedIntoTree, prost::Name};
use tendermint::abci::EventAttribute;
use tonic::async_trait;
use tracing::instrument;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Indexed, Indexer, LogMeta,
    MerkleTreeInsertion, SequenceAwareIndexer, H256, H512,
};

use crate::{ConnectionConf, CosmosNativeProvider, HyperlaneCosmosError, RpcProvider};

use super::{EventIndexer, ParsedEvent};

/// delivery indexer to check if a message was delivered
#[derive(Debug, Clone)]
pub struct CosmosNativeTreeInsertionIndexer {
    provider: CosmosNativeProvider,
    address: H256,
}

impl CosmosNativeTreeInsertionIndexer {
    ///  New Tree Insertion Indexer
    pub fn new(provider: CosmosNativeProvider, locator: ContractLocator) -> ChainResult<Self> {
        Ok(CosmosNativeTreeInsertionIndexer {
            provider,
            address: locator.address,
        })
    }
}

impl EventIndexer<MerkleTreeInsertion> for CosmosNativeTreeInsertionIndexer {
    fn target_type() -> String {
        InsertedIntoTree::full_name()
    }

    fn provider(&self) -> &RpcProvider {
        self.provider.rpc()
    }

    #[instrument(err)]
    fn parse(&self, attrs: &[EventAttribute]) -> ChainResult<ParsedEvent<MerkleTreeInsertion>> {
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
                "merkle_tree_hook_id" => {
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

    fn address(&self) -> &H256 {
        &self.address
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
        EventIndexer::fetch_logs_in_range(self, range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        EventIndexer::get_finalized_block_number(self).await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
        EventIndexer::fetch_logs_by_tx_hash(self, tx_hash).await
    }
}

#[async_trait]
impl SequenceAwareIndexer<MerkleTreeInsertion> for CosmosNativeTreeInsertionIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = EventIndexer::get_finalized_block_number(self).await?;
        let merkle_tree = self
            .provider
            .grpc()
            .merkle_tree_hook(self.address.encode_hex(), Some(tip))
            .await?;
        match merkle_tree.merkle_tree_hook {
            Some(merkle_tree) if merkle_tree.merkle_tree.is_some() => {
                let count = merkle_tree.merkle_tree.unwrap().count;
                Ok((Some(count), tip))
            }
            _ => Ok((None, tip)),
        }
    }
}
