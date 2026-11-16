use std::any::Any;
use std::error::Error as StdError;
use std::fmt::{Debug, Display, Formatter};
use std::num::TryFromIntError;
use std::ops::Deref;

use bigdecimal::ParseBigDecimalError;

use crate::config::StrOrIntParseError;
use crate::rpc_clients::RpcClientError;
use std::string::FromUtf8Error;

use crate::{
    DiagnosticError, Error as PrimitiveTypeError, HyperlaneProviderError, HyperlaneSignerError,
    ReorgPeriod, H256, U256,
};

/// The result of interacting with a chain.
pub type ChainResult<T = ()> = Result<T, ChainCommunicationError>;

/// An "Any"-typed error.
pub trait HyperlaneCustomError: StdError + Send + Sync + Any {}

impl<E: StdError + Send + Sync + Any> HyperlaneCustomError for E {}

/// Thin wrapper around a boxed HyperlaneCustomError; required to satisfy
/// AsDynError implementations. Basically a trait-object adaptor.
pub struct HyperlaneCustomErrorWrapper(Box<dyn HyperlaneCustomError>, Option<Box<DiagnosticError>>);

impl HyperlaneCustomErrorWrapper {
    /// Wrap an error and retain any typed public evidence before type erasure.
    pub fn new(error: Box<dyn HyperlaneCustomError>) -> Self {
        #[cfg(feature = "ethers")]
        let diagnostic = evm_error_diagnostic(error.as_ref()).map(Box::new);
        #[cfg(not(feature = "ethers"))]
        let diagnostic = None;
        Self(error, diagnostic)
    }
}

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
    /// When a transaction is not found
    #[error("Address is not a contract {0}")]
    ContractNotFound(String),
    /// A transaction was dropped from the mempool
    #[error("Transaction dropped from mempool {0:?}")]
    TransactionDropped(H256),
    /// Any other error; does not implement `From` to prevent
    /// conflicting/absorbing other errors.
    #[error(transparent)]
    Other(HyperlaneCustomErrorWrapper),
    /// A transaction submission timed out
    #[error("Transaction submission timed out")]
    TransactionTimeout,
    /// No signer is available and was required for the operation
    #[error("Signer unavailable")]
    SignerUnavailable,
    /// Batching transaction failed
    #[error("Batching transaction failed")]
    BatchingFailed,
    /// Cannot submit empty batch
    #[error("Cannot submit empty batch")]
    BatchIsEmpty,
    /// Failed to parse strings or integers
    #[error("Data parsing error {0:?}")]
    StrOrIntParseError(#[from] StrOrIntParseError),
    /// utf8 error
    #[error("{0}")]
    Utf8(#[from] FromUtf8Error),
    /// Serde JSON error
    #[error("{0}")]
    JsonParseError(#[from] serde_json::Error),
    /// String hex parsing error
    #[error("{0}")]
    HexParseError(#[from] hex::FromHexError),
    /// Uint hex parsing error
    #[error("{0}")]
    UintParseError(#[from] uint::FromHexError),
    /// Decimal string parsing error
    #[error("{0}")]
    FromDecStrError(#[from] uint::FromDecStrErr),
    /// Int string parsing error
    #[error("{0}")]
    ParseIntError(#[from] std::num::ParseIntError),
    /// Hash string parsing error
    #[error("{0}")]
    HashParsingError(#[from] fixed_hash::rustc_hex::FromHexError),
    /// Invalid Request
    #[error("Invalid Request: {msg:?}")]
    InvalidRequest {
        /// Error message
        msg: String,
    },
    /// Parse Error
    #[error("ParseError: {msg:?}")]
    ParseError {
        /// Error message
        msg: String,
    },
    /// Insufficient funds.
    #[error("Insufficient funds. Required: {required:?}, available: {available:?}")]
    InsufficientFunds {
        /// The required amount of funds.
        required: Box<U256>,
        /// The available amount of funds.
        available: Box<U256>,
    },
    /// Primitive type error
    #[error(transparent)]
    PrimitiveTypeError(#[from] PrimitiveTypeError),
    /// Big decimal parsing error
    #[error(transparent)]
    ParseBigDecimalError(#[from] ParseBigDecimalError),
    /// Rpc client error
    #[error(transparent)]
    RpcClientError(#[from] RpcClientError),
    /// Tokio join error
    #[cfg(feature = "async")]
    #[error(transparent)]
    TokioJoinError(#[from] tokio::task::JoinError),
    /// Custom error
    #[error("{0}")]
    CustomError(String),
    /// Eyre error
    #[error("{0}")]
    EyreError(#[from] eyre::Report),
    /// Hyperlane signer error
    #[error("{0}")]
    HyperlaneSignerError(#[from] HyperlaneSignerError),
    /// Invalid reorg period
    #[error("Invalid reorg period: {0:?}")]
    InvalidReorgPeriod(ReorgPeriod),
    /// Convert Integer Error
    #[error("{0}")]
    TryFromIntError(#[from] TryFromIntError),
    /// Simulation failed
    #[error("Simulation failed: {0}")]
    SimulationFailed(String),
}

impl ChainCommunicationError {
    /// Stable, sanitized category used by existing activity reason fields.
    pub fn diagnostic_reason(&self) -> &'static str {
        self.diagnostic_summary().0
    }

    fn diagnostic_summary(&self) -> (&'static str, &'static str) {
        use ChainCommunicationError::*;
        match self {
            HyperlaneProtocolError(_) => ("protocol_error", "Protocol operation failed"),
            ContractError(_) => ("contract_call_failed", "Contract call failed"),
            ContractNotFound(_) => ("contract_not_found", "Contract was not found"),
            TransactionDropped(_) => ("transaction_dropped", "Transaction was dropped"),
            TransactionTimeout => ("transaction_timeout", "Transaction timed out"),
            SignerUnavailable => ("signer_unavailable", "Transaction signer is unavailable"),
            HyperlaneSignerError(_) => ("signer_error", "Transaction signing failed"),
            BatchingFailed => ("batching_failed", "Transaction batching failed"),
            BatchIsEmpty => ("empty_batch", "Transaction batch was empty"),
            InsufficientFunds { .. } => ("insufficient_funds", "Insufficient native funds"),
            RpcClientError(_) => ("rpc_error", "RPC request failed"),
            InvalidRequest { .. } => ("invalid_request", "Chain request was invalid"),
            InvalidReorgPeriod(_) => ("invalid_reorg_period", "Chain reorg period was invalid"),
            SimulationFailed(_) => ("simulation_failed", "Transaction simulation failed"),
            #[cfg(feature = "async")]
            TokioJoinError(_) => ("task_failed", "Chain operation task failed"),
            StrOrIntParseError(_)
            | Utf8(_)
            | JsonParseError(_)
            | HexParseError(_)
            | UintParseError(_)
            | FromDecStrError(_)
            | ParseIntError(_)
            | HashParsingError(_)
            | ParseError { .. }
            | PrimitiveTypeError(_)
            | ParseBigDecimalError(_)
            | TryFromIntError(_) => (
                "invalid_response_or_data",
                "Chain response or data could not be decoded",
            ),
            Other(_) | CustomError(_) | EyreError(_) => ("chain_error", "Chain operation failed"),
        }
    }

    /// Public evidence without serializing opaque provider errors.
    pub fn diagnostic(&self) -> DiagnosticError {
        use ChainCommunicationError::*;
        let diagnostic = || {
            let (code, message) = self.diagnostic_summary();
            DiagnosticError::new(code, message, "chain")
        };
        match self {
            ContractError(error) | Other(error) => {
                error.1.as_deref().cloned().unwrap_or_else(diagnostic)
            }
            InsufficientFunds {
                required,
                available,
            } => diagnostic()
                .with_detail("required", required.to_string())
                .with_detail("available", available.to_string()),
            RpcClientError(crate::rpc_clients::RpcClientError::FallbackProvidersFailed(errors)) => {
                DiagnosticError::new("rpc_providers_failed", "All RPC providers failed", "rpc")
                    .with_causes(errors.iter().map(Self::diagnostic).collect())
            }
            EyreError(report) => {
                if let Some(error) = report.downcast_ref::<Self>() {
                    return error.diagnostic();
                }
                #[cfg(feature = "ethers")]
                if let Some(error) = evm_error_diagnostic(report.as_ref()) {
                    return error;
                }
                diagnostic()
            }
            _ => diagnostic(),
        }
    }

    /// Create a chain communication error from any other existing error
    pub fn from_other<E: HyperlaneCustomError>(err: E) -> Self {
        Self::Other(HyperlaneCustomErrorWrapper::new(Box::new(err)))
    }

    /// Create a chain communication error from any other existing error
    pub fn from_other_boxed<E: HyperlaneCustomError>(err: Box<E>) -> Self {
        Self::Other(HyperlaneCustomErrorWrapper::new(err))
    }

    /// Creates a chain communication error of the other error variant from a string slice
    pub fn from_other_str(err: &str) -> Self {
        #[derive(Debug)]
        #[repr(transparent)]
        struct StringError(String);
        impl Display for StringError {
            fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
        impl StdError for StringError {}

        Self::from_contract_error(StringError(err.to_owned()))
    }

    /// Creates a chain communication error of the contract error variant from any other existing
    /// error
    pub fn from_contract_error<E>(err: E) -> Self
    where
        E: HyperlaneCustomError,
    {
        Self::ContractError(HyperlaneCustomErrorWrapper::new(Box::new(err)))
    }

    /// Creates a chain communication error of the contract error variant from any other existing
    /// error
    pub fn from_contract_error_boxed<E>(err: Box<E>) -> Self
    where
        E: HyperlaneCustomError,
    {
        Self::ContractError(HyperlaneCustomErrorWrapper::new(err))
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

impl From<HyperlaneProviderError> for ChainCommunicationError {
    fn from(e: HyperlaneProviderError) -> Self {
        Self::from_other(e)
    }
}

#[cfg(feature = "ethers")]
impl<T: ethers_providers::Middleware + 'static> From<ethers_contract::ContractError<T>>
    for ChainCommunicationError
{
    fn from(err: ethers_contract::ContractError<T>) -> Self {
        let diagnostic = match &err {
            ethers_contract::ContractError::MiddlewareError(error) => evm_error_diagnostic(error),
            ethers_contract::ContractError::ProviderError(error) => evm_error_diagnostic(error),
            _ => None,
        };
        Self::ContractError(HyperlaneCustomErrorWrapper(
            Box::new(err),
            diagnostic.map(Box::new),
        ))
    }
}

#[cfg(feature = "ethers")]
impl From<ethers_providers::ProviderError> for ChainCommunicationError {
    fn from(err: ethers_providers::ProviderError) -> Self {
        let diagnostic = evm_error_diagnostic(&err);
        Self::ContractError(HyperlaneCustomErrorWrapper(
            Box::new(err),
            diagnostic.map(Box::new),
        ))
    }
}

#[cfg(feature = "ethers")]
fn evm_error_diagnostic(error: &(dyn StdError + 'static)) -> Option<DiagnosticError> {
    let mut source = Some(error);
    while let Some(error) = source {
        if let Some(ethers_providers::ProviderError::JsonRpcClientError(inner)) =
            error.downcast_ref::<ethers_providers::ProviderError>()
        {
            source = Some(inner.as_ref());
            continue;
        }
        if let Some(ethers_providers::HttpClientError::JsonRpcError(response)) =
            error.downcast_ref::<ethers_providers::HttpClientError>()
        {
            let data = response.data.as_ref().and_then(|data| {
                data.as_str()
                    .or_else(|| data.get("data").and_then(serde_json::Value::as_str))
            });
            if let Some(data) = data
                .filter(|_| {
                    response.code == 3 || response.message.to_ascii_lowercase().contains("revert")
                })
                .and_then(|data| data.strip_prefix("0x"))
                .filter(|data| data.len() <= 8192)
            {
                if let Ok(data) = hex::decode(data) {
                    return Some(DiagnosticError::from_evm_revert(&data));
                }
            }
            return Some(
                DiagnosticError::new(
                    "rpc_response_error",
                    "RPC returned an error response",
                    "rpc",
                )
                .with_detail("rpc_code", response.code),
            );
        }
        if let Some(error) = error.downcast_ref::<ChainCommunicationError>() {
            return Some(error.diagnostic());
        }
        if let Some(ethers_providers::ProviderError::HTTPError(error)) =
            error.downcast_ref::<ethers_providers::ProviderError>()
        {
            let (code, message) = if error.is_timeout() {
                ("rpc_request_timeout", "RPC request timed out")
            } else if error.is_connect() {
                ("rpc_connection_failed", "RPC connection failed")
            } else {
                ("rpc_request_failed", "RPC request failed")
            };
            let mut diagnostic = DiagnosticError::new(code, message, "rpc");
            if let Some(status) = error.status() {
                diagnostic = diagnostic.with_detail("http_status", status.as_u16());
            }
            return Some(diagnostic);
        }
        source = error.source();
    }
    None
}

/// Error types for the Hyperlane protocol
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneProtocolError {
    /// Signature Error pasthrough
    #[cfg(feature = "ethers")]
    #[error(transparent)]
    SignatureError(#[from] Box<ethers_core::types::SignatureError>),
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

#[cfg(all(test, feature = "ethers"))]
mod diagnostic_tests {
    use super::*;
    use serde_json::json;

    fn rpc_error(data: serde_json::Value) -> ethers_providers::ProviderError {
        let error = ethers_providers::HttpClientError::JsonRpcError(
            serde_json::from_value(json!({
            "code": -32000, "message": "execution reverted: private provider text", "data": data,
            }))
            .expect("valid test value"),
        );
        ethers_providers::ProviderError::JsonRpcClientError(Box::new(error))
    }

    #[test]
    fn preserves_rpc_revert_evidence_through_contract_and_fallback_wrappers() {
        type Provider = ethers_providers::Provider<ethers_providers::MockProvider>;
        let error: ChainCommunicationError =
            ethers_contract::ContractError::<Provider>::MiddlewareError(rpc_error(json!(
                "0xdeadbeef"
            )))
            .into();
        assert_eq!(error.diagnostic().details["revert_selector"], "0xdeadbeef");
        let error =
            ChainCommunicationError::RpcClientError(RpcClientError::FallbackProvidersFailed(vec![
                error,
            ]));
        assert_eq!(error.diagnostic().causes[0].code, "execution_reverted");
        assert!(!serde_json::to_string(&error.diagnostic())
            .expect("valid test value")
            .contains("private"));
    }

    #[test]
    fn retains_rpc_codes_and_native_fund_amounts() {
        let error: ChainCommunicationError = rpc_error(serde_json::Value::Null).into();
        assert_eq!(error.diagnostic().details["rpc_code"], -32000);
        let error = ChainCommunicationError::InsufficientFunds {
            required: Box::new(2.into()),
            available: Box::new(1.into()),
        }
        .diagnostic();
        assert_eq!(error.details["required"], "2");
        assert_eq!(error.details["available"], "1");
    }
}
