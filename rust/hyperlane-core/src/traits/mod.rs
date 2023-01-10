pub use cursor::*;
pub use deployed::*;
pub use encode::*;
pub use indexer::*;
pub use interchain_gas::*;
pub use mailbox::*;
pub use multisig_ism::*;
pub use provider::*;

mod cursor;
mod deployed;
mod encode;
mod indexer;
mod interchain_gas;
mod mailbox;
mod multisig_ism;
mod provider;

/// The result of a transaction
#[derive(Debug, Clone, Copy)]
pub struct TxOutcome {
    /// The txid
    pub txid: crate::H256,
    /// True if executed, false otherwise (reverted, etc.)
    pub executed: bool,
    // TODO: more? What can be abstracted across all chains?
}

impl From<ethers::prelude::TransactionReceipt> for TxOutcome {
    fn from(t: ethers::prelude::TransactionReceipt) -> Self {
        Self {
            txid: t.transaction_hash,
            executed: t.status.unwrap().low_u32() == 1,
        }
    }
}
