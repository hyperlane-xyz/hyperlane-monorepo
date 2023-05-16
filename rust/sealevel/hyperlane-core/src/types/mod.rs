use borsh::{BorshDeserialize, BorshSerialize};

pub mod checkpoint;
pub use checkpoint::*;

pub mod message;
pub use message::*;

pub use primitive_types::{H160, H256, U256};

#[derive(BorshDeserialize, BorshSerialize)]
pub enum IsmType {
    None = 0,
    Routing = 1,
    Aggregation = 2,
    LegacyMultisig = 3,
    MerkleRootMultisig = 4,
    MessageIdMultisig = 5,
}
