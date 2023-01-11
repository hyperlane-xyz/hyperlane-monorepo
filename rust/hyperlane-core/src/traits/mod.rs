pub use cursor::*;
pub use encode::*;
pub use indexer::*;
pub use interchain_gas::*;
pub use mailbox::*;
pub use multisig_ism::*;
pub use provider::*;
pub use validator_announce::*;

mod cursor;
mod encode;
mod indexer;
mod interchain_gas;
mod mailbox;
mod multisig_ism;
mod provider;
mod validator_announce;

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

/// Interface for features of something deployed on/in a domain or is otherwise
/// connected to it.
#[auto_impl::auto_impl(Box, Arc)]
pub trait HyperlaneChain {
    /// Return an identifier (not necessarily unique) for the chain this
    /// is connected to
    fn domain(&self) -> &crate::HyperlaneDomain;
}

/// Interface for a deployed contract.
/// This trait is intended to expose attributes of any contract, and
/// should not consider the purpose or implementation details of the contract.
#[auto_impl::auto_impl(Box, Arc)]
pub trait HyperlaneContract: HyperlaneChain {
    /// Return the address of this contract.
    fn address(&self) -> crate::H256;
}

/// Static contract ABI information.
#[auto_impl::auto_impl(Box, Arc)]
pub trait HyperlaneAbi {
    /// Get a mapping from function selectors to human readable function names.
    fn fn_map() -> std::collections::HashMap<ethers::prelude::Selector, &'static str>;

    /// Get a mapping from function selectors to owned human readable function
    /// names.
    fn fn_map_owned() -> std::collections::HashMap<ethers::prelude::Selector, String> {
        Self::fn_map()
            .into_iter()
            .map(|(sig, name)| (sig, name.to_owned()))
            .collect()
    }
}
