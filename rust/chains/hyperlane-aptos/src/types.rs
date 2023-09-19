use std::str::FromStr;

use aptos_sdk::rest_client::aptos_api_types::VersionedEvent;
use hyperlane_core::{
    accumulator::{incremental::IncrementalMerkle, TREE_DEPTH},
    ChainCommunicationError, Decode, HyperlaneMessage, H256,
};
use serde::{Deserialize, Serialize};

/// Merkle Tree content from MoveResource
#[derive(Serialize, Deserialize)]
pub struct MoveMerkleTree {
    branch: Vec<String>,
    count: String,
}

impl From<MoveMerkleTree> for IncrementalMerkle {
    fn from(val: MoveMerkleTree) -> Self {
        let mut branches: Vec<H256> = vec![];
        for branch in val.branch.iter() {
            branches.push(H256::from_str(branch).unwrap());
        }
        if branches.len() < 32 {
            while branches.len() < 32 {
                branches.push(H256::zero());
            }
        }
        let count = val.count.parse::<usize>().unwrap();

        IncrementalMerkle::plant(branches[0..TREE_DEPTH].try_into().unwrap(), count)
    }
}

/// Event Data of Message Dispatch
#[allow(missing_docs)]
#[derive(Serialize, Deserialize, Debug)]
pub struct DispatchEventData {
    pub dest_domain: u64,
    pub message: String,
    pub message_id: String,
    pub recipient: String,
    pub block_height: String,
    pub transaction_hash: String,
    pub sender: String,
}

impl TryFrom<VersionedEvent> for DispatchEventData {
    type Error = ChainCommunicationError;
    fn try_from(value: VersionedEvent) -> Result<Self, Self::Error> {
        serde_json::from_str::<Self>(&value.data.to_string())
            .map_err(ChainCommunicationError::from_other)
    }
}

impl DispatchEventData {
    /// convert message bytes into Hyperlane Message
    pub fn into_hyperlane_msg(
        &mut self,
    ) -> Result<HyperlaneMessage, hyperlane_core::HyperlaneProtocolError> {
        let hex_bytes = hex::decode(&self.message.trim_start_matches("0x")).unwrap();
        HyperlaneMessage::read_from(&mut &hex_bytes[..])
    }
}
