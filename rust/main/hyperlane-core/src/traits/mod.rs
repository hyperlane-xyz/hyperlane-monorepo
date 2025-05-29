pub use aggregation_ism::*;
pub use ccip_read_ism::*;

pub use cursor::*;
pub use db::*;
pub use deployed::*;
pub use encode::*;
pub use indexer::*;
pub use interchain_gas::*;
pub use interchain_security_module::*;
pub use mailbox::*;
pub use merkle_tree_hook::*;
pub use multisig_ism::*;
pub use pending_operation::*;
pub use provider::*;
pub use routing_ism::*;
pub use signing::*;

pub use validator_announce::*;

use crate::{FixedPointNumber, H512, U256};

mod aggregation_ism;
mod ccip_read_ism;
mod cursor;
mod db;
mod deployed;
mod encode;
mod indexer;
mod interchain_gas;
mod interchain_security_module;
mod mailbox;
mod merkle_tree_hook;
mod multisig_ism;
mod pending_operation;
mod provider;
mod routing_ism;
mod signing;
mod validator_announce;

/// The result of a transaction
#[derive(Debug, Clone)]
pub struct TxOutcome {
    /// The transaction identifier/hash
    pub transaction_id: H512,
    /// True if executed, false otherwise (reverted, etc.)
    pub executed: bool,
    /// Amount of gas used on this transaction.
    pub gas_used: U256,
    /// Price paid for the gas
    pub gas_price: FixedPointNumber,
    // TODO: more? What can be abstracted across all chains?
}

#[cfg(feature = "ethers")]
impl From<ethers_core::types::TransactionReceipt> for TxOutcome {
    fn from(t: ethers_core::types::TransactionReceipt) -> Self {
        Self {
            transaction_id: t.transaction_hash.into(),
            executed: t.status.unwrap().low_u32() == 1,
            gas_used: t.gas_used.map(Into::into).unwrap_or(U256::zero()),
            gas_price: t
                .effective_gas_price
                .and_then(|price| U256::from(price).try_into().ok())
                .unwrap_or(FixedPointNumber::zero()),
        }
    }
}
