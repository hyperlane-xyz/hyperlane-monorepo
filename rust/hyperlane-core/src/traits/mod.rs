pub use cursor::*;
pub use deployed::*;
pub use encode::*;
pub use indexer::*;
pub use interchain_gas::*;
pub use ism::*;
pub use mailbox::*;
pub use multisig_ism::*;
pub use provider::*;
pub use signing::*;
pub use validator_announce::*;

mod cursor;
mod deployed;
mod encode;
mod indexer;
mod interchain_gas;
mod ism;
mod mailbox;
mod multisig_ism;
mod provider;
mod signing;
mod validator_announce;

/// The result of a transaction
#[derive(Debug, Clone, Copy)]
pub struct TxOutcome {
    /// The txid
    pub txid: crate::H256,
    /// True if executed, false otherwise (reverted, etc.)
    pub executed: bool,
    /// Amount of gas used on this transaction.
    pub gas_used: crate::U256,
    /// Price paid for the gas
    pub gas_price: crate::U256,
    // TODO: more? What can be abstracted across all chains?
}

impl From<ethers::prelude::TransactionReceipt> for TxOutcome {
    fn from(t: ethers::prelude::TransactionReceipt) -> Self {
        Self {
            txid: t.transaction_hash,
            executed: t.status.unwrap().low_u32() == 1,
            gas_used: t.gas_used.unwrap_or(crate::U256::zero()),
            gas_price: t.effective_gas_price.unwrap_or(crate::U256::zero()),
        }
    }
}
