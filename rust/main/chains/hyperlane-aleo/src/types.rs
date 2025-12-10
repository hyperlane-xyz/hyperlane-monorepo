use aleo_serialize_macro::aleo_serialize;
use serde::{Deserialize, Serialize};

use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, utils::to_atto, HyperlaneMessage,
    InterchainGasPayment, MerkleTreeInsertion, H256, U256,
};
use snarkvm::prelude::{MainnetV0, Network};
use snarkvm_console_account::{Address, Itertools};

use crate::utils::{aleo_hash_to_h256, bytes_to_u128_words};

/// Type alias for the Aleo network used throughout this codebase.
///
/// This actually works for all networks. I've raised this with the Aleo team, but the type annotation here doesn't actually change the underlying type.
/// The Aleo VM types all inherit a generic Network type, but that Type is not relevant for many structs of Aleo and is supposed to be more of an additional information for the internal VM processing.
/// They need this, because they generate ZK Proofs differently for different networks but the actual data of these types are the same across all Networks.
/// We pass CurrentNetwork into a lot of types, because we don't have to generate ZK Proofs in almost every situation - except when submitting a TX. There is one exception to this and that is when parsing/handling with Blocks.
/// The Block type verifies its validity on creation and that changes based on the Network type, that's why we have to pass the correct Type when dealing with blocks.
pub type CurrentNetwork = MainnetV0;

/// Aleo Hash Type, for performance reasons the aleo contracts use [u128;2] to represent 32 byte hashes
/// Each u128 is encoded in little-endian byte order
pub(crate) type AleoHash = [u128; 2];

// The aleo credits have 6 decimals
const CREDITS_DECIMALS: u32 = 6;
// Message body is 16 u128 words this results in 256 bytes
// Each u128 is encoded in little-endian byte order
// This is a constant defined by the Hyperlane Aleo contracts
pub(crate) const MESSAGE_BODY_U128_WORDS: usize = 16;
// Aleo contracts define a maximum of 6 validators for multisigs
pub(crate) const MAX_VALIDATORS: usize = 6;

/// Aleo Merkle Tree
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMerkleTree {
    /// Leaf Branch
    /// Each leaf is 32Bytes encoded as [u128; 2], where the u128 is little endian encoded
    pub branch: [AleoHash; 32],
    /// Number of inserted elements
    pub count: u32,
}

impl From<AleoMerkleTree> for IncrementalMerkle {
    fn from(val: AleoMerkleTree) -> Self {
        let branch = val.branch.map(|hash| aleo_hash_to_h256(&hash));
        IncrementalMerkle {
            branch,
            count: val.count as usize,
        }
    }
}

/// Aleo Merkle Tree Hook
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMerkleTreeHookStruct {
    /// Merkle Tree
    pub tree: AleoMerkleTree,
    /// Computed on chain merkle root as [u128; 2]
    /// u128 is little endian encoded
    pub root: AleoHash,
}

/// Aleo Eth address representation
#[aleo_serialize]
#[derive(Debug, Copy, Clone)]
pub struct AleoEthAddress {
    /// Address bytes
    pub bytes: [u8; 20],
}

/// Aleo Message Id Multisig
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMessagesIdMultisig {
    /// Validators, empty valiadtors will be zero-address
    pub validators: [AleoEthAddress; MAX_VALIDATORS],
    /// Validator count
    pub validator_count: u8,
    /// Threshold
    pub threshold: u8,
}

/// Aleo GasPaymentEvent
#[aleo_serialize]
#[derive(Debug)]
pub struct GasPaymentEvent {
    /// MessageId encoded as [u128;2], each u128 is encoded in little endian
    pub id: AleoHash,
    /// Destination domain
    pub destination_domain: u32,
    /// Gas amount
    pub gas_amount: u128,
    /// Payment in Aleo credits
    pub payment: u64,
    /// Event index
    pub index: u32,
}

impl From<GasPaymentEvent> for InterchainGasPayment {
    fn from(val: GasPaymentEvent) -> Self {
        let message_id = aleo_hash_to_h256(&val.id);
        InterchainGasPayment {
            message_id,
            destination: val.destination_domain,
            payment: to_atto(U256::from(val.payment), CREDITS_DECIMALS).unwrap_or_default(),
            gas_amount: U256::from(val.gas_amount),
        }
    }
}

/// InsertedIntoTree Event
#[aleo_serialize]
#[derive(Debug)]
pub struct InsertIntoTreeEvent {
    /// MessageId encoded as [u128;2], each u128 is encoded in little endian
    pub id: AleoHash,
    /// Event index
    pub index: u32,
}

impl From<InsertIntoTreeEvent> for MerkleTreeInsertion {
    fn from(val: InsertIntoTreeEvent) -> Self {
        let message_id = aleo_hash_to_h256(&val.id);
        MerkleTreeInsertion::new(val.index, message_id)
    }
}

/// Represents a cross-chain message in the Hyperlane protocol on Aleo network.
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMessage {
    /// Message format version
    pub version: u8,
    /// Unique message identifier
    pub nonce: u32,
    /// Domain ID of the source chain
    pub origin_domain: u32,
    /// Address of the message sender (32 bytes)
    pub sender: [u8; 32],
    /// Domain ID of the destination chain
    pub destination_domain: u32,
    /// Address of the message recipient (32 bytes)
    pub recipient: [u8; 32],
    /// Message payload data (16 x 128-bit words)
    pub body: [u128; MESSAGE_BODY_U128_WORDS],
}

impl From<AleoMessage> for HyperlaneMessage {
    fn from(val: AleoMessage) -> Self {
        // Aleo encodes its integers with little endian
        // We only need to convert the body bytes as only the body is encoded as u128 words in the contracts
        let body = val.body.iter().flat_map(|x| x.to_le_bytes()).collect_vec();
        let sender = H256::from(val.sender);
        let recipient = H256::from(val.recipient);
        HyperlaneMessage {
            version: val.version,
            nonce: val.nonce,
            origin: val.origin_domain,
            sender,
            destination: val.destination_domain,
            recipient,
            body,
        }
    }
}

impl From<HyperlaneMessage> for AleoMessage {
    fn from(message: HyperlaneMessage) -> Self {
        // Convert the variable-length body bytes (<= 256) into 16 little-endian u128 words (zero‑padded).
        let body = bytes_to_u128_words(&message.body);

        AleoMessage {
            version: message.version,
            nonce: message.nonce,
            origin_domain: message.origin,
            sender: message.sender.to_fixed_bytes(),
            destination_domain: message.destination,
            recipient: message.recipient.to_fixed_bytes(),
            body,
        }
    }
}

/// Aleo Mailbox struct
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMailboxStruct<N: Network = CurrentNetwork> {
    /// Number of processed messages
    pub process_count: u32,
    /// Number of dispatched messages
    pub nonce: u32,
    /// Default ISM
    pub default_ism: Address<N>,
}

/// Aleo InterchainGasPaymaster struct
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoInterchainGasPaymaster {
    /// Used for sequencing events
    pub count: u32,
}

/// Aleo delivery
#[aleo_serialize]
#[derive(Debug)]
pub struct Delivery<N: Network = CurrentNetwork> {
    /// Address that executed the process
    pub processor: Address<N>,
    /// The block height of the delivery
    pub block_number: u32,
}

/// Hook Event Index
#[aleo_serialize]
#[derive(Debug)]
pub struct HookEventIndex<N: Network = CurrentNetwork> {
    /// Hook
    pub hook: Address<N>,
    /// Height
    pub block_height: u32,
}

#[aleo_serialize]
#[derive(Debug)]
pub struct RouteKey<N: Network = CurrentNetwork> {
    /// Ism address
    pub ism: Address<N>,
    /// Domain
    pub domain: u32,
}

/// Proving Request
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProvingRequest {
    /// The function that needs to be executed
    pub authorization: serde_json::Value, // Some type of Authorization::<Network>
    /// Fee for the TX
    pub fee_authorization: Option<serde_json::Value>,
    /// Whether or not the service will broadcast the transaction
    pub broadcast: bool,
}

/// Proving Response
#[derive(Serialize, Deserialize, Debug)]
pub struct ProvingResponse {
    /// Transaction with Proof
    pub transaction: serde_json::Value, // Transaction::<Network>
    /// Whether or not it was broadcasted
    #[serde(default)]
    pub broadcast: Option<bool>,
}

/// Fee estimate for Aleo transactions
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeeEstimate {
    /// Base fee
    pub base_fee: u64,
    /// Priority fee
    pub priority_fee: u64,
    /// Total fee
    pub total_fee: u64,
}

impl FeeEstimate {
    /// Creates a new FeeEstimate with the total fee calculated automatically
    ///
    /// # Arguments
    /// * `base_fee` - The base transaction fee in microcredits
    /// * `priority_fee` - The priority fee in microcredits
    ///
    /// # Returns
    /// A new FeeEstimate with total_fee = base_fee + priority_fee
    ///
    /// # Example
    /// ```ignore
    /// use hyperlane_aleo::types::FeeEstimate;
    ///
    /// let fee = FeeEstimate::new(1000, 100);
    /// assert_eq!(fee.base_fee, 1000);
    /// assert_eq!(fee.priority_fee, 100);
    /// assert_eq!(fee.total_fee, 1100);
    /// ```
    pub fn new(base_fee: u64, priority_fee: u64) -> Self {
        Self {
            base_fee,
            priority_fee,
            total_fee: base_fee.saturating_add(priority_fee),
        }
    }
}

#[aleo_serialize]
#[derive(Debug)]
pub struct DeliveryKey {
    /// Message ID
    pub id: AleoHash,
}

#[aleo_serialize]
#[derive(Debug)]
pub struct AppMetadata<N: Network = CurrentNetwork> {
    /// Custom ISM used by the application
    pub ism: Address<N>,
    /// Custom Hook used by the application
    pub hook: Address<N>,
}

#[aleo_serialize]
#[derive(Debug)]
pub struct StorageLocationKey {
    /// Validator
    pub validator: [u8; 20],
    /// Index
    pub index: u8,
}

/// Data required to construct Aleo transaction
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AleoTxData {
    /// Program ID to call
    pub program_id: String,
    /// Function name to call on the program
    pub function_name: String,
    /// Input parameters for the function call
    pub inputs: Vec<String>,
}

/// Data required to get mapping value by program and mapping key
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AleoGetMappingValue {
    /// Program ID to get mapping for
    pub program_id: String,
    /// Mapping name
    pub mapping_name: String,
    /// Mapping key
    pub mapping_key: String,
}

#[cfg(test)]
mod tests;
