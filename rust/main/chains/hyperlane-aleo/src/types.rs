use aleo_serialize_macro::aleo_serialize;

use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, utils::to_atto, HyperlaneMessage,
    InterchainGasPayment, MerkleTreeInsertion, H256, U256,
};
use snarkvm::{
    console::network::{const_assert, hrp2, AleoID},
    prelude::{MainnetV0, Network},
};
use snarkvm_console_account::{Address, Field, Itertools};

use crate::utils::u128_to_hash;

// This actually works for all networks. I've raised this with the Aleo team, but the type annotation here doesn't actually change the underlying type.
// The Aleo VM types all inherit a generic Network type, but that Type is not relevant for many structs of Aleo and is supposed to be more of an additional information for the internal VM processing.
// They need this, because they generate ZK Proofs differently for different networks but the actual data of these types are the same across all Networks.
// We pass CurrentNetwork into a lot of types, because we don't have to generate ZK Proofs in almost every situation - except when submitting a TX. There is one exception to this and that is when parsing/handling with Blocks.
// The Block type verifies its validity on creation and that changes based on the Network type, that's why we have to pass the correct Type when dealing with blocks.
pub(crate) type CurrentNetwork = MainnetV0;
/// TxID Type
pub(crate) type TxID = AleoID<Field<CurrentNetwork>, { hrp2!("at") }>;

// The aleo credits have 6 decimals
const ALEO_CREDITS_DECIMALS: u32 = 6;

/// Aleo Merkle Tree
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMerkleTree {
    /// Leaf Branch
    /// Each leaf is 32Bytes encoded as [u128; 2], where the u128 is little endian encoded
    pub branch: [[u128; 2]; 32],
    /// Number of inserted elements
    pub count: u32,
}

impl Into<IncrementalMerkle> for AleoMerkleTree {
    fn into(self) -> IncrementalMerkle {
        let branch = self.branch.map(|hash| u128_to_hash(&hash));
        IncrementalMerkle {
            branch,
            count: self.count as usize,
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
    pub root: [u128; 2],
}

/// Aleo Eth address representation
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoEthAddress {
    /// Address bytes
    pub bytes: [u8; 20],
}

const MAX_VALIDATORS: usize = 6;

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
    /// MessageId encoded as [u128;2] each u128 is encoded in little endian
    pub id: [u128; 2],
    /// Destination domain
    pub destination_domain: u32,
    /// Gas amount
    pub gas_amount: u128,
    /// Payment in Aleo credits
    pub payment: u64,
    /// Event index
    pub index: u32,
}

impl Into<InterchainGasPayment> for GasPaymentEvent {
    fn into(self) -> InterchainGasPayment {
        let message_id = u128_to_hash(&self.id);
        InterchainGasPayment {
            message_id,
            destination: self.destination_domain,
            payment: to_atto(U256::from(self.payment), ALEO_CREDITS_DECIMALS).unwrap_or_default(),
            gas_amount: U256::from(self.gas_amount),
        }
    }
}

/// InsertedIntoTree Event
#[aleo_serialize]
#[derive(Debug)]
pub struct InsertIntoTreeEvent {
    /// MessageId encoded as [u128;2, each u128 is encoded in little endian
    pub id: [u128; 2],
    /// Event index
    pub index: u32,
}

impl Into<MerkleTreeInsertion> for InsertIntoTreeEvent {
    fn into(self) -> MerkleTreeInsertion {
        let message_id = u128_to_hash(&self.id);
        MerkleTreeInsertion::new(self.index, message_id)
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
    /// Message payload data (8 x 128-bit words)
    pub body: [u128; 8],
}

impl Into<HyperlaneMessage> for AleoMessage {
    fn into(self) -> HyperlaneMessage {
        // Aleo encodes its integers with little endian
        let body = self.body.iter().flat_map(|x| x.to_le_bytes()).collect_vec();
        let sender = H256::from(self.sender);
        let recipient = H256::from(self.recipient);
        HyperlaneMessage {
            version: self.version,
            nonce: self.nonce,
            origin: self.origin_domain,
            sender,
            destination: self.destination_domain,
            recipient,
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
