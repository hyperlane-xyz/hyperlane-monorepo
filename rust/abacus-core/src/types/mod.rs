use ethers::types::U256;

mod checkpoint;
mod messages;

/// Unified 32-byte identifier with convenience tooling for handling
/// 20-byte ids (e.g ethereum addresses)
pub mod identifiers;

pub use checkpoint::*;
pub use messages::*;

/// A payment of Outbox native tokens for a message
pub struct InterchainGasPayment {
    /// The index of the message's leaf in the merkle tree
    pub leaf_index: u32,
    /// The payment amount, in Outbox native token wei
    pub amount: U256,
}
