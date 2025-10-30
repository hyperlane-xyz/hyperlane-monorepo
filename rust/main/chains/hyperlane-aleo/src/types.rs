use crate::HyperlaneAleoError;
use aleo_serialize::{fetch_field, AleoSerialize};
use aleo_serialize_macro::aleo_serialize;
use anyhow::Result;
use hyperlane_core::accumulator::incremental::IncrementalMerkle;
use hyperlane_core::{
    ChainResult, HyperlaneMessage, InterchainGasPayment, MerkleTreeInsertion, H256, U256,
};
use snarkvm::console::network::{const_assert, hrp2, AleoID};
use snarkvm::prelude::Itertools;
use snarkvm::prelude::{
    Boolean, Field, FromBytes, Identifier, Network, Plaintext, ProgramID, TestnetV0, ToBits,
    ToBytes, U128, U32, U64, U8,
};
use snarkvm_console_account::Address;

/// Current Network that is used global
pub type CurrentNetwork = TestnetV0;
/// TxID Type
pub type TxID = AleoID<Field<TestnetV0>, { hrp2!("at") }>;

// TODO: this should be in a util crate

/// Converts a [U128; 2] into a H256
pub fn u128_to_hash(id: &[U128<CurrentNetwork>; 2]) -> H256 {
    let bytes = id
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect_vec();
    H256::from_slice(&bytes)
}

/// Converts a H256 into [U128; 2]
pub fn hash_to_u128(id: &H256) -> ChainResult<[U128<CurrentNetwork>; 2]> {
    let first = &id.as_fixed_bytes()[..16];
    let second = &id.as_fixed_bytes()[16..];
    return Ok([
        U128::<CurrentNetwork>::from_bytes_le(first).map_err(HyperlaneAleoError::from)?,
        U128::<CurrentNetwork>::from_bytes_le(second).map_err(HyperlaneAleoError::from)?,
    ]);
}

/// Convert a H256 into a TxID
pub fn get_tx_id(hash: impl Into<H256>) -> ChainResult<TxID> {
    Ok(TxID::from_bytes_le(hash.into().as_bytes()).map_err(HyperlaneAleoError::from)?)
}

/// Convert a TxID or any other struct that implements ToBytes to H256
pub fn to_h256<T: ToBytes>(id: T) -> ChainResult<H256> {
    let bytes = id.to_bytes_le().map_err(HyperlaneAleoError::from)?;
    Ok(H256::from_slice(&bytes))
}

/// Returns the key ID for the given `program ID`, `mapping name`, and `key`.
pub fn to_key_id<N: Network>(
    program_id: &ProgramID<N>,
    mapping_name: &Identifier<N>,
    key: &Plaintext<N>,
) -> ChainResult<Field<N>> {
    // Construct the preimage.
    let mut preimage = Vec::new();
    program_id.write_bits_le(&mut preimage);
    false.write_bits_le(&mut preimage); // Separator
    mapping_name.write_bits_le(&mut preimage);
    false.write_bits_le(&mut preimage); // Separator
    key.write_bits_le(&mut preimage);
    // Compute the key ID.
    Ok(N::hash_bhp1024(&preimage).map_err(HyperlaneAleoError::from)?)
}

/// Aleo Merkle Tree
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMerkleTree<N: Network = CurrentNetwork> {
    /// Leaf Branch
    /// Each leaf is 32Bytes encoded as [u128; 2], where the u128 is little endian encoded
    pub branch: [[U128<N>; 2]; 32],
    /// Number of inserted elements
    pub count: U32<N>,
}

impl Into<IncrementalMerkle> for AleoMerkleTree {
    fn into(self) -> IncrementalMerkle {
        let branch = self.branch.map(|hash| u128_to_hash(&hash));
        IncrementalMerkle {
            branch,
            count: *self.count as usize,
        }
    }
}

/// Aleo Merkle Tree Hook
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMerkleTreeHookStruct<N: Network = CurrentNetwork> {
    /// Merkle Tree
    pub tree: AleoMerkleTree<N>,
    /// Computed on chain merkle root as [u128; 2]
    /// u128 is little endian encoded
    pub root: [U128<N>; 2],
}

/// Aleo Eth address representation
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoEthAddress<N: Network = CurrentNetwork> {
    /// Address bytes
    pub bytes: [U8<N>; 20],
}

const MAX_VALIDATORS: usize = 6;

/// Aleo Message Id Multisig
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMessagesIdMultisig<N: Network = CurrentNetwork> {
    /// Validators, empty valiadtors will be zero-address
    pub validators: [AleoEthAddress<N>; MAX_VALIDATORS],
    /// Validator count
    pub validator_count: U8<N>,
    /// Threshold
    pub threshold: U8<N>,
}

/// Aleo GasPaymentEvent
#[aleo_serialize]
#[derive(Debug)]
pub struct GasPaymentEvent<N: Network = CurrentNetwork> {
    /// MessageId encoded as [u128;2, each u128 is encoded in little endian
    pub id: [U128<N>; 2],
    /// Destination domain
    pub destination_domain: U32<N>,
    /// Gas amount
    pub gas_amount: U128<N>,
    /// Payment in Aleo credits
    pub payment: U64<N>,
    /// Event index
    pub index: U32<N>,
}

impl Into<InterchainGasPayment> for GasPaymentEvent {
    fn into(self) -> InterchainGasPayment {
        let message_id = u128_to_hash(&self.id);
        InterchainGasPayment {
            message_id,
            destination: *self.destination_domain,
            payment: U256::from(*self.payment), // TODO: This should be denominated by 18 decimals, convert this to attos
            gas_amount: U256::from(*self.gas_amount),
        }
    }
}

/// InsertedIntoTree Event
#[aleo_serialize]
#[derive(Debug)]
pub struct InsertIntoTreeEvent<N: Network = CurrentNetwork> {
    /// MessageId encoded as [u128;2, each u128 is encoded in little endian
    pub id: [U128<N>; 2],
    /// Event index
    pub index: U32<N>,
}

impl Into<MerkleTreeInsertion> for InsertIntoTreeEvent {
    fn into(self) -> MerkleTreeInsertion {
        let message_id = u128_to_hash(&self.id);
        MerkleTreeInsertion::new(*self.index, message_id)
    }
}

/// Represents a cross-chain message in the Hyperlane protocol on Aleo network.
///
/// Generic over network type `N`, defaulting to `CurrentNetwork`.
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMessage<N: Network = CurrentNetwork> {
    /// Message format version
    pub version: U8<N>,
    /// Unique message identifier
    pub nonce: U32<N>,
    /// Domain ID of the source chain
    pub origin_domain: U32<N>,
    /// Address of the message sender (32 bytes)
    pub sender: [U8<N>; 32],
    /// Domain ID of the destination chain
    pub destination_domain: U32<N>,
    /// Address of the message recipient (32 bytes)
    pub recipient: [U8<N>; 32],
    /// Message payload data (8 x 128-bit words)
    pub body: [U128<N>; 8],
}

impl Into<HyperlaneMessage> for AleoMessage {
    fn into(self) -> HyperlaneMessage {
        // Aleo encodes its integers with little endian
        let body = self.body.iter().flat_map(|x| x.to_le_bytes()).collect_vec();
        let sender = H256::from(self.sender.map(|x| *x));
        let recipient = H256::from(self.recipient.map(|x| *x));
        HyperlaneMessage {
            version: *self.version,
            nonce: *self.nonce,
            origin: *self.origin_domain,
            sender,
            destination: *self.destination_domain,
            recipient,
            body: body,
        }
    }
}

/// Aleo Mailbox struct
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoMailboxStruct<N: Network = CurrentNetwork> {
    /// Number of processed messages
    pub process_count: U32<N>,
    /// Number of dispatched messages
    pub nonce: U32<N>,
    /// Default ISM
    pub default_ism: Address<N>,
}

/// Aleo InterchainGasPaymaster struct
#[aleo_serialize]
#[derive(Debug)]
pub struct AleoInterchainGasPaymaster<N: Network = CurrentNetwork> {
    /// Used for sequencing events
    pub count: U32<N>,
}

/// Aleo delivery
#[aleo_serialize]
#[derive(Debug)]
pub struct Delivery<N: Network = CurrentNetwork> {
    /// Address that executed the process
    pub processor: Address<N>,
    /// The block height of the delivery
    pub block_number: U32<N>,
}

/// Storage location
#[aleo_serialize]
#[derive(Debug)]
pub struct StorageLocationKey<N: Network = CurrentNetwork> {
    /// Validator
    pub validator: [U8<N>; 20],
    /// Index
    pub index: U8<N>,
}
