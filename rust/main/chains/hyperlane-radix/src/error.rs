use bech32::{DecodeError, EncodeError};
use chrono::ParseError;
use core_api_client::apis::Error as CoreError;
use gateway_api_client::apis::Error as GatewayError;
use scrypto::math::ParseDecimalError;

use hyperlane_core::ChainCommunicationError;

use crate::EventParseError;

/// Errors from the crates specific to the hyperlane-radix
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneRadixError {
    /// Reqwest Error
    #[error("Reqwest error: {0}")]
    ReqwestError(#[from] reqwest::Error),
    /// Serde Error
    #[error("Serde error: {0}")]
    Serde(#[from] serde_json::Error),
    /// IO Error
    #[error("Io error: {0}")]
    Io(#[from] std::io::Error),
    /// Response Error
    #[error("Response error: {0}")]
    ResponseError(String),
    /// Parsing Error
    #[error("Parsing error: {0}")]
    ParsingError(String),
    /// Bech32 error
    #[error("Decode error: {0}")]
    DecodeError(#[from] DecodeError),
    /// Bech32 error
    #[error("Decode error: {0}")]
    EncodeError(#[from] EncodeError),
    /// Event Parse error
    #[error("Event parse error: {0}")]
    EventParseError(#[from] EventParseError),
    /// Call Method failed
    #[error("Sbor call method error: {0}")]
    SborCallMethod(String),
    /// SborDecode failed
    #[error("Sbor decode error: {0}")]
    SborDecode(String),
    /// SborEncode failed
    #[error("Sbor encode error: {0}")]
    SborEncode(String),
    /// Signer missing
    #[error("Signer missing")]
    SignerMissing,
    /// Bech32Encode failed
    #[error("Bech32 error: {0}")]
    Bech32Error(String),
    /// Date time error
    #[error("DateTime error: {0}")]
    DateTime(#[from] ParseError),
    /// parse float error
    #[error("Parse Decimal error: {0}")]
    ParseDecimal(#[from] ParseDecimalError),
    /// Other errors
    #[error("{0}")]
    Other(String),
}

impl From<HyperlaneRadixError> for ChainCommunicationError {
    fn from(value: HyperlaneRadixError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}

impl<T: std::fmt::Debug> From<CoreError<T>> for HyperlaneRadixError {
    fn from(value: CoreError<T>) -> Self {
        match value {
            CoreError::Reqwest(err) => Self::ReqwestError(err),
            CoreError::Serde(err) => Self::Serde(err),
            CoreError::Io(err) => Self::Io(err),
            CoreError::ResponseError(response) => Self::ResponseError(format!("{response:?}")),
        }
    }
}

impl<T: std::fmt::Debug> From<GatewayError<T>> for HyperlaneRadixError {
    fn from(value: GatewayError<T>) -> Self {
        match value {
            GatewayError::Reqwest(err) => Self::ReqwestError(err),
            GatewayError::Serde(err) => Self::Serde(err),
            GatewayError::Io(err) => Self::Io(err),
            GatewayError::ResponseError(response) => Self::ResponseError(format!("{response:?}")),
        }
    }
}

impl From<sbor::DecodeError> for HyperlaneRadixError {
    fn from(err: sbor::DecodeError) -> Self {
        Self::SborDecode(format!("{err:?}"))
    }
}

impl From<sbor::EncodeError> for HyperlaneRadixError {
    fn from(err: sbor::EncodeError) -> Self {
        Self::SborEncode(format!("{err:?}"))
    }
}
