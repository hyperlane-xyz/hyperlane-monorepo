use std::collections::HashMap;
use std::error::Error as StdError;
use std::fmt::Debug;

use auto_impl::auto_impl;
use ethers::prelude::Selector;
use ethers::{
    contract::ContractError,
    core::types::{TransactionReceipt, H256},
    providers::{Middleware, ProviderError},
};

pub use encode::*;
pub use indexer::*;
pub use interchain_gas::*;
pub use mailbox::*;
pub use multisig_module::*;

use crate::{db::DbError, AbacusError};

mod encode;
mod indexer;
mod interchain_gas;
mod mailbox;
mod multisig_module;

/// The result of a transaction
#[derive(Debug, Clone, Copy)]
pub struct TxOutcome {
    /// The txid
    pub txid: H256,
    /// True if executed, false otherwise (reverted, etc.)
    pub executed: bool,
    // TODO: more? What can be abstracted across all chains?
}

impl From<TransactionReceipt> for TxOutcome {
    fn from(t: TransactionReceipt) -> Self {
        Self {
            txid: t.transaction_hash,
            executed: t.status.unwrap().low_u32() == 1,
        }
    }
}

/// ChainCommunicationError contains errors returned when attempting to
/// call a chain or dispatch a transaction
#[derive(Debug, thiserror::Error)]
pub enum ChainCommunicationError {
    /// Abacus Error
    #[error("{0}")]
    AbacusError(#[from] AbacusError),
    /// Contract Error
    #[error("{0}")]
    ContractError(Box<dyn StdError + Send + Sync>),
    /// Provider Error
    #[error("{0}")]
    ProviderError(#[from] ProviderError),
    /// A transaction was dropped from the mempool
    #[error("Transaction dropped from mempool {0:?}")]
    DroppedError(H256),
    /// DB Error
    #[error("{0}")]
    DbError(#[from] DbError),
    /// Any other error
    #[error("{0}")]
    CustomError(#[from] Box<dyn StdError + Send + Sync>),
    /// A transaction submission timed out
    #[error("Transaction submission timed out")]
    TransactionTimeout(),
}

impl<M> From<ContractError<M>> for ChainCommunicationError
where
    M: Middleware + 'static,
{
    fn from(e: ContractError<M>) -> Self {
        Self::ContractError(Box::new(e))
    }
}

/// Interface for features of something deployed on/in a domain or is otherwise
/// connected to it.
#[auto_impl(Box, Arc)]
pub trait AbacusChain {
    /// Return an identifier (not necessarily unique) for the chain this
    /// is connected to
    fn chain_name(&self) -> &str;

    /// Return the domain ID
    fn local_domain(&self) -> u32;

    /// Return the domain hash
    fn local_domain_hash(&self) -> H256 {
        domain_hash(self.local_domain())
    }
}

/// Interface for a deployed contract.
/// This trait is intended to expose attributes of any contract, and
/// should not consider the purpose or implementation details of the contract.
#[auto_impl(Box, Arc)]
pub trait AbacusContract: AbacusChain {
    /// Return the address of this contract.
    fn address(&self) -> H256;
}

/// Static contract ABI information.
#[auto_impl(Box, Arc)]
pub trait AbacusAbi {
    /// Get a mapping from function selectors to human readable function names.
    fn fn_map() -> HashMap<Selector, &'static str>;

    /// Get a mapping from function selectors to owned human readable function
    /// names.
    fn fn_map_owned() -> HashMap<Selector, String> {
        Self::fn_map()
            .into_iter()
            .map(|(sig, name)| (sig, name.to_owned()))
            .collect()
    }
}
