use std::any::Any;
use std::error::Error as StdError;
use std::fmt::{Debug, Display, Formatter};
use std::ops::Deref;

use ethers_contract::ContractError;
use ethers_core::types::SignatureError;
use ethers_providers::{Middleware, ProviderError};

use crate::HyperlaneProviderError;
use crate::H256;

/// The result of interacting with a chain.
pub type ChainResult<T> = Result<T, ChainCommunicationError>;

/// An "Any"-typed error.
pub trait HyperlaneCustomError: StdError + Send + Sync + Any {}

impl<E: StdError + Send + Sync + Any> HyperlaneCustomError for E {}

/// Thin wrapper around a boxed HyperlaneCustomError; required to satisfy
/// AsDynError implementations. Basically a trait-object adaptor.
#[repr(transparent)]
pub struct HyperlaneCustomErrorWrapper(Box<dyn HyperlaneCustomError>);

impl Debug for HyperlaneCustomErrorWrapper {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", AsRef::<dyn HyperlaneCustomError>::as_ref(&self))
    }
}

impl Display for HyperlaneCustomErrorWrapper {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", AsRef::<dyn HyperlaneCustomError>::as_ref(&self))
    }
}

impl StdError for HyperlaneCustomErrorWrapper {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.0.source()
    }
}

impl AsRef<dyn HyperlaneCustomError> for HyperlaneCustomErrorWrapper {
    fn as_ref(&self) -> &dyn HyperlaneCustomError {
        self.0.as_ref()
    }
}

impl Deref for HyperlaneCustomErrorWrapper {
    type Target = Box<dyn HyperlaneCustomError>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// ChainCommunicationError contains errors returned when attempting to
/// call a chain or dispatch a transaction
#[derive(Debug, thiserror::Error)]
pub enum ChainCommunicationError {
    /// Hyperlane Error
    #[error(transparent)]
    HyperlaneProtocolError(#[from] HyperlaneProtocolError),
    /// An error with a contract call
    #[error(transparent)]
    ContractError(HyperlaneCustomErrorWrapper),
    /// Provider Error
    #[error(transparent)]
    ProviderError(#[from] ProviderError),
    /// A transaction was dropped from the mempool
    #[error("Transaction dropped from mempool {0:?}")]
    TransactionDropped(H256),
    /// Any other error; does not implement `From` to prevent
    /// conflicting/absorbing other errors.
    #[error(transparent)]
    Other(HyperlaneCustomErrorWrapper),
    /// A transaction submission timed out
    #[error("Transaction submission timed out")]
    TransactionTimeout(),
}

impl ChainCommunicationError {
    /// Create a chain communication error from any other existing error
    pub fn from_other<E: HyperlaneCustomError>(err: E) -> Self {
        Self::Other(HyperlaneCustomErrorWrapper(Box::new(err)))
    }

    /// Create a chain communication error from any other existing error
    pub fn from_other_boxed<E: HyperlaneCustomError>(err: Box<E>) -> Self {
        Self::Other(HyperlaneCustomErrorWrapper(err))
    }

    /// Creates a chain communication error of the other error variant from a static string
    pub fn from_other_str(err: &'static str) -> Self {
        #[derive(Debug)]
        #[repr(transparent)]
        struct StringError(&'static str);
        impl Display for StringError {
            fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.0)
            }
        }
        impl StdError for StringError {}

        Self::from_contract_error(StringError(err))
    }

    /// Creates a chain communication error of the contract error variant from any other existing
    /// error
    pub fn from_contract_error<E>(err: E) -> Self
    where
        E: HyperlaneCustomError
    {
        Self::ContractError(HyperlaneCustomErrorWrapper(Box::new(err)))
    }

    /// Creates a chain communication error of the contract error variant from any other existing
    /// error
    pub fn from_contract_error_boxed<E>(err: Box<E>) -> Self
    where
        E: HyperlaneCustomError
    {
        Self::ContractError(HyperlaneCustomErrorWrapper(err))
    }

    /// Creates a chain communication error of the contract error variant from a static string
    pub fn from_contract_error_str(err: &'static str) -> Self {
        #[derive(Debug)]
        #[repr(transparent)]
        struct StringError(&'static str);
        impl Display for StringError {
            fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.0)
            }
        }
        impl StdError for StringError {}

        Self::from_contract_error(StringError(err))
    }
}

impl<M> From<ContractError<M>> for ChainCommunicationError
where
    M: Middleware + 'static,
{
    fn from(e: ContractError<M>) -> Self {
        Self::ContractError(HyperlaneCustomErrorWrapper(Box::new(e)))
    }
}

impl From<HyperlaneProviderError> for ChainCommunicationError {
    fn from(e: HyperlaneProviderError) -> Self {
        Self::from_other(e)
    }
}

/// Error types for the Hyperlane protocol
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneProtocolError {
    /// Signature Error pasthrough
    #[error(transparent)]
    SignatureError(#[from] SignatureError),
    /// IO error from Read/Write usage
    #[error(transparent)]
    IoError(#[from] std::io::Error),
    /// An unknown or invalid domain id was encountered
    #[error("Unknown or invalid domain ID ({0})")]
    UnknownDomainId(u32),
    /// Expected a gas limit and none was provided
    #[error("A gas limit was expected for `process` contract call")]
    ProcessGasLimitRequired,
}
