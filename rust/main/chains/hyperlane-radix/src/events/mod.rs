use hyperlane_core::{InterchainGasPayment, H160, H256};
use radix_common::prelude::*;

use crate::decimal_to_u256;

/// EthAddress representation used by the radix contracts
#[derive(Debug, Clone, PartialEq, Eq, Copy, Sbor, Hash, PartialOrd, Ord)]
#[sbor(transparent)]
pub struct EthAddress([u8; 20]);

impl From<EthAddress> for H160 {
    fn from(value: EthAddress) -> Self {
        H160(value.0)
    }
}

impl From<&H256> for EthAddress {
    fn from(value: &H256) -> Self {
        let bytes = H160::from(*value);
        EthAddress(bytes.0)
    }
}

impl From<H160> for EthAddress {
    fn from(value: H160) -> Self {
        EthAddress(value.0)
    }
}

/// Bytes32 representation used by the radix contracts
#[derive(Clone, Eq, PartialEq, Hash, Sbor, ScryptoEvent, PartialOrd, Ord, Copy, Default, Debug)]
#[sbor(transparent)]
pub struct Bytes32(pub [u8; 32]);

impl From<Bytes32> for H256 {
    fn from(value: Bytes32) -> Self {
        H256(value.0)
    }
}

impl From<H256> for Bytes32 {
    fn from(value: H256) -> Self {
        Bytes32(value.0)
    }
}

impl Bytes32 {
    /// returns the raw slice
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl From<[u8; 32]> for Bytes32 {
    fn from(bytes: [u8; 32]) -> Self {
        Bytes32(bytes)
    }
}

/// Radix dispatch event
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct DispatchEvent {
    /// domain
    pub destination: u32,
    /// encoded recipient
    pub recipient: Bytes32,
    /// raw message
    pub message: Vec<u8>,
    /// sequence of the dispatch count, this is equal to the nonce
    pub sequence: u32,
}

/// Process event
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct ProcessIdEvent {
    /// encoded message id that has been processed
    pub message_id: Bytes32,
    /// sequence of the process
    pub sequence: u32,
}

/// Inserted into tree event
#[derive(ScryptoSbor, ScryptoEvent, Debug)]
pub struct InsertedIntoTreeEvent {
    /// the message id encoded
    pub id: Bytes32,
    /// index of the leaf that has been inserted
    pub index: u32,
}

/// Hash representation used by the radix implementation
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Sbor)]
#[sbor(transparent)]
pub struct Hash(pub [u8; 32]);

/// MerkleTree that is used by the radix implementation
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct MerkleTree {
    /// all the branches of the tree
    pub branch: [Hash; 32],
    /// current amount of ingested leafs
    pub count: usize,
}

/// IsmTypes for the radix implementation
/// equal to the relayer implementation, just needed for the sbor encoding
#[derive(ScryptoSbor, ScryptoEvent)]
pub enum IsmTypes {
    /// INVALID ISM
    Unused,
    /// Routing ISM (defers to another ISM)
    Routing,
    /// Aggregation ISM (aggregates multiple ISMs)
    Aggregation,
    /// Legacy ISM (DEPRECATED)
    LegacyMultisig,
    /// Merkle Proof ISM (batching and censorship resistance)
    MerkleRootMultisig,
    /// Message ID ISM (cheapest multisig with no batching)
    MessageIdMultisig,
    /// No metadata ISM (no metadata)
    Null,
    /// Ccip Read ISM (accepts offchain signature information)
    CcipRead,
}

/// Gas payment event
#[derive(ScryptoSbor, ScryptoEvent)]
pub struct GasPayment {
    /// encoded message id
    pub message_id: Bytes32,
    /// destination domain
    pub destination_domain: u32,
    /// Gas amount in a decimal
    pub gas_amount: Decimal,
    /// resource payment
    pub payment: Decimal,
    /// resource addresses that was paid in
    pub resource_address: String,
    /// Sequence of the event
    pub sequence: u32,
}

impl From<GasPayment> for InterchainGasPayment {
    fn from(value: GasPayment) -> Self {
        // Convert Decimal gas_amount (in attos) to whole gas units by dividing by 10^18.
        // decimal_to_u256(Decimal::ONE) == 10^18, so types stay U256 / U256.
        let gas_amount = decimal_to_u256(value.gas_amount) / decimal_to_u256(Decimal::ONE);
        Self {
            message_id: value.message_id.into(),
            destination: value.destination_domain,
            payment: decimal_to_u256(value.payment),
            gas_amount,
        }
    }
}
