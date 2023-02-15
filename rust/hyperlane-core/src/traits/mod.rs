pub use cursor::*;
pub use deployed::*;
pub use encode::*;
pub use indexer::*;
pub use interchain_gas::*;
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
    /// Index of the log transaction's logs
    pub log_index: u64,
    /// True if executed, false otherwise (reverted, etc.)
    pub executed: bool,
    /// Amoutn of gas spent on this transaction.
    pub gas_spent: crate::U256,
    // TODO: more? What can be abstracted across all chains?
}

impl From<ethers::prelude::TransactionReceipt> for TxOutcome {
    fn from(t: ethers::prelude::TransactionReceipt) -> Self {
        Self {
            txid: t.transaction_hash,
            log_index: t.transaction_index.as_u64(),
            executed: t.status.unwrap().low_u32() == 1,
            gas_spent: t.gas_used.unwrap_or(crate::U256::zero()),
        }
    }
}
