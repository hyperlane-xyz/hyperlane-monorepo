use std::fmt;

pub use cursor::*;
pub use encode::*;
pub use indexer::*;
pub use interchain_gas::*;
pub use mailbox::*;
pub use multisig_ism::*;
pub use provider::*;

use crate::{HyperlaneDomain, H256};

mod cursor;
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
    pub txid: H256,
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
    /// Return the domain ID
    fn domain(&self) -> HyperlaneDomain;
}

/// Interface for a deployed contract.
/// This trait is intended to expose attributes of any contract, and
/// should not consider the purpose or implementation details of the contract.
#[auto_impl::auto_impl(Box, Arc)]
pub trait HyperlaneContract: HyperlaneChain {
    /// Return the address of this contract.
    fn address(&self) -> H256;
}

/// Static contract ABI information.
#[auto_impl::auto_impl(Box, Arc)]
pub trait HyperlaneAbi {
    /// Size of the returned selector byte arrays.
    const SELECTOR_SIZE_BYTES: usize;

    /// Get a mapping from function selectors to human readable function names.
    fn fn_map() -> std::collections::HashMap<Vec<u8>, &'static str>;

    /// Get a mapping from function selectors to owned human readable function
    /// names.
    fn fn_map_owned() -> std::collections::HashMap<Vec<u8>, String> {
        Self::fn_map()
            .into_iter()
            .map(|(sig, name)| (sig, name.to_owned()))
            .collect()
    }
}

impl fmt::Debug for dyn HyperlaneChain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let domain = self.domain();
        write!(f, "HyperlaneChain({} ({}))", domain, domain as u32)
    }
}

impl fmt::Debug for dyn HyperlaneContract {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let domain = self.domain();
        write!(
            f,
            "HyperlaneContract({:?} @ {} ({}))",
            self.address(),
            domain,
            domain as u32,
        )
    }
}
