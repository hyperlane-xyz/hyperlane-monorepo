use aleo_serialize::{fetch_field, AleoSerialize};
use aleo_serialize_macro::aleo_serialize;
use snarkvm::console::network::{const_assert, hrp2, AleoID};
use snarkvm::prelude::Itertools;
use snarkvm::prelude::{Field, Network, TestnetV0};
use snarkvm_console_account::Address;

use hyperlane_core::accumulator::incremental::IncrementalMerkle;
use hyperlane_core::utils::to_atto;
use hyperlane_core::{HyperlaneMessage, InterchainGasPayment, MerkleTreeInsertion, H256, U256};

use crate::utils::u128_to_hash;

/// Current Network that is used global
/// TODO: docs
pub type CurrentNetwork = TestnetV0;
/// TxID Type
pub type TxID = AleoID<Field<TestnetV0>, { hrp2!("at") }>;

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
            payment: to_atto(U256::from(self.payment), 6).unwrap_or_default(),
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

/// Storage location
#[aleo_serialize]
#[derive(Debug)]
pub struct StorageLocationKey {
    /// Validator
    pub validator: [u8; 20],
    /// Index
    pub index: u8,
}

/// Delivery Key
#[aleo_serialize]
#[derive(Debug)]
pub struct DeliveryKey {
    /// Id
    pub id: [u128; 2],
}

/// RouteKey
#[aleo_serialize]
#[derive(Debug)]
pub struct RouteKey<N: Network = CurrentNetwork> {
    /// Ism address
    pub ism: Address<N>,
    /// Domain
    pub domain: u32,
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
