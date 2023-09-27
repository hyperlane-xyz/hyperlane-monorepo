use std::str::FromStr;

use aptos_sdk::rest_client::aptos_api_types::VersionedEvent;
use hyperlane_core::{
    accumulator::{incremental::IncrementalMerkle, TREE_DEPTH},
    ChainCommunicationError, Decode, HyperlaneMessage, InterchainGasPayment, H256, U256,
};
use serde::{Deserialize, Serialize};

use crate::utils;

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

/// Trait for event types which returns trasaction_hash and block_height
pub trait TxSpecificData {
    /// return block_height
    fn block_height(&self) -> String;
    /// return transaction_hash
    fn transaction_hash(&self) -> String;
}

/// Event Data of Message Dispatch
#[allow(missing_docs)]
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DispatchEventData {
    pub dest_domain: u64,
    pub message: String,
    pub message_id: String,
    pub recipient: String,
    pub block_height: String,
    pub transaction_hash: String,
    pub sender: String,
}

impl TxSpecificData for DispatchEventData {
    fn block_height(&self) -> String {
        self.block_height.clone()
    }
    fn transaction_hash(&self) -> String {
        self.transaction_hash.clone()
    }
}

impl TryFrom<VersionedEvent> for DispatchEventData {
    type Error = ChainCommunicationError;
    fn try_from(value: VersionedEvent) -> Result<Self, Self::Error> {
        serde_json::from_str::<Self>(&value.data.to_string())
            .map_err(ChainCommunicationError::from_other)
    }
}

impl TryInto<HyperlaneMessage> for DispatchEventData {
    type Error = hyperlane_core::HyperlaneProtocolError;
    fn try_into(self) -> Result<HyperlaneMessage, Self::Error> {
        let hex_bytes = hex::decode(&self.message.trim_start_matches("0x")).unwrap();
        HyperlaneMessage::read_from(&mut &hex_bytes[..])
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
/// Move Value Data of GasPayment Event
pub struct GasPaymentEventData {
    /// hyperlane message id
    pub message_id: String,
    /// gas amount
    pub gas_amount: String,
    /// quoted gas payment
    pub required_amount: String,
    /// block number
    pub block_height: String,
    /// hash of transaction
    pub transaction_hash: String,
}

impl TryFrom<VersionedEvent> for GasPaymentEventData {
    type Error = ChainCommunicationError;
    fn try_from(value: VersionedEvent) -> Result<Self, Self::Error> {
        serde_json::from_str::<Self>(&value.data.to_string())
            .map_err(ChainCommunicationError::from_other)
    }
}

impl TryInto<InterchainGasPayment> for GasPaymentEventData {
    type Error = ChainCommunicationError;
    fn try_into(self) -> Result<InterchainGasPayment, Self::Error> {
        Ok(InterchainGasPayment {
            message_id: utils::convert_hex_string_to_h256(&self.message_id).unwrap(),
            payment: U256::from_str(&self.required_amount)
                .map_err(ChainCommunicationError::from_other)
                .unwrap(),
            gas_amount: U256::from_str(&self.gas_amount)
                .map_err(ChainCommunicationError::from_other)
                .unwrap(),
        })
    }
}

impl TxSpecificData for GasPaymentEventData {
    fn block_height(&self) -> String {
        self.block_height.clone()
    }
    fn transaction_hash(&self) -> String {
        self.transaction_hash.clone()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
/// Move Value Data of GasPayment Event
pub struct MsgProcessEventData {
    /// hyperlane message id
    pub message_id: String,
    /// domain of origin chain
    pub origin_domain: u32,
    /// address of sender (router)
    pub sender: String,
    /// address of recipient
    pub recipient: String,
    /// block number
    pub block_height: String,
    /// hash of transaction
    pub transaction_hash: String,
}

impl TryFrom<VersionedEvent> for MsgProcessEventData {
    type Error = ChainCommunicationError;
    fn try_from(value: VersionedEvent) -> Result<Self, Self::Error> {
        serde_json::from_str::<Self>(&value.data.to_string())
            .map_err(ChainCommunicationError::from_other)
    }
}

impl TryInto<H256> for MsgProcessEventData {
    type Error = ChainCommunicationError;
    fn try_into(self) -> Result<H256, Self::Error> {
        Ok(utils::convert_hex_string_to_h256(&self.message_id).unwrap())
    }
}

impl TxSpecificData for MsgProcessEventData {
    fn block_height(&self) -> String {
        self.block_height.clone()
    }
    fn transaction_hash(&self) -> String {
        self.transaction_hash.clone()
    }
}
